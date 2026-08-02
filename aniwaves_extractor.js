process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const https = require('https');
const vm = require('vm');

// The sandboxed player script schedules its own async work. If one of those
// callbacks throws, it must not kill the process before we print our results.
process.on('unhandledRejection', (err) => {
    console.error(`Warning: async error in player script: ${err && err.message}`);
});
process.on('uncaughtException', (err) => {
    console.error(`Warning: uncaught error in player script: ${err && err.message}`);
});

const watchUrl = process.argv[2];
if (!watchUrl) {
    console.error(JSON.stringify({ error: "No watch URL provided as an argument" }));
    process.exit(1);
}

function parseJsonResponse(raw, label) {
    const trimmed = (raw || '').trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
        const gatewayMatch = trimmed.match(/error code:\s*(\d+)/i);
        if (gatewayMatch) {
            throw new Error(`${label} failed: upstream returned gateway error ${gatewayMatch[1]} (not JSON) -- the site is likely down or timing out, try again shortly`);
        }
        throw new Error(`${label} failed: upstream returned a non-JSON response: ${trimmed.slice(0, 200) || '(empty body)'}`);
    }
    try {
        return JSON.parse(trimmed);
    } catch (e) {
        throw new Error(`${label} failed: malformed JSON (${e.message})`);
    }
}

function fetchPage(url, referer = '') {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(url);
        const options = {
            hostname: parsedUrl.hostname,
            path: parsedUrl.pathname + parsedUrl.search,
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
                'Accept': '*/*'
            }
        };
        if (referer) {
            options.headers['Referer'] = referer;
        }

        const req = https.get(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => resolve(data));
        });

        req.on('error', (err) => reject(err));
    });
}

async function run() {
    try {
        const match = watchUrl.match(/watch\/([a-zA-Z0-9-]*?)-(\d+)\/ep-(\d+)/);
        if (!match) {
            console.error(JSON.stringify({ error: "Failed to parse anime ID and episode from URL" }));
            return;
        }
        const animeSlug = match[1];
        const animeId = match[2];
        const epNum = match[3];

        const serverListUrl = `https://aniwaves.ru/ajax/server/list?servers=${animeId}&eps=${epNum}`;
        const serverListRaw = await fetchPage(serverListUrl, watchUrl);
        const serverListJson = parseJsonResponse(serverListRaw, 'Server list request');
        
        if (serverListJson.status !== 200) {
            console.error(JSON.stringify({ error: `Failed to fetch server list: ${serverListJson.message}` }));
            return;
        }

        const html = serverListJson.result;

        // Extract servers
        const servers = [];
        const typeMatches = [...html.matchAll(/<div class="type" data-type="([^"]+)">[\s\S]*?<\/ul>/g)];
        for (const typeMatch of typeMatches) {
            const type = typeMatch[1]; // "sub", "ssub", "dub"
            const liMatches = [...typeMatch[0].matchAll(/<li[^>]*?data-sv-id="([^"]+)"[^>]*?data-link-id="([^"]+)"[^>]*?>([^<]+)<\/li>/g)];
            for (const liMatch of liMatches) {
                servers.push({
                    type: type,
                    server_id: liMatch[1],
                    link_id: liMatch[2],
                    name: liMatch[3].trim()
                });
            }
        }

        // Filter for DUB, SUB and S-SUB (Soft-sub) Vidplay/MyCloud
        const dubVidplay = servers.find(s => s.type === 'dub' && s.server_id === '4');
        const subVidplay = servers.find(s => s.type === 'sub' && s.server_id === '4');
        const ssubMyCloud = servers.find(s => s.type === 'ssub' && s.server_id === '12');

        const targets = [];
        if (dubVidplay) targets.push({ name: 'DUB', server: dubVidplay });
        if (subVidplay) targets.push({ name: 'SUB', server: subVidplay });
        if (ssubMyCloud) targets.push({ name: 'S-SUB', server: ssubMyCloud });

        if (targets.length === 0 && servers.length > 0) {
            targets.push({ name: 'DEFAULT', server: servers[0] });
        }

        const output = {
            animeSlug,
            animeId,
            episode: epNum,
            results: {}
        };

        for (const target of targets) {
            const targetServer = target.server;
            const sourcesUrl = `https://aniwaves.ru/ajax/sources?id=${encodeURIComponent(targetServer.link_id)}&asi=0&autoPlay=0`;
            const sourcesRaw = await fetchPage(sourcesUrl, watchUrl);
            const sourcesJson = parseJsonResponse(sourcesRaw, `Sources request (${target.name})`);

            if (!sourcesJson.status || !sourcesJson.result || !sourcesJson.result.url) {
                continue;
            }

            const embedUrl = sourcesJson.result.url;
            const embedHtml = await fetchPage(embedUrl, 'https://aniwaves.ru/');

            // Find data-id and data-realid in mg-player
            const divMatch = embedHtml.match(/id="mg-player"\s+data-id="([^"]+)"\s+data-realid="([^"]+)"/);
            if (!divMatch) {
                continue;
            }
            const dataId = divMatch[1];
            const dataRealId = divMatch[2];

            // Extract Script 3
            const scripts = [...embedHtml.matchAll(/<script[^>]*?>([\s\S]*?)<\/script>/g)];
            let obfuscatedCode = '';
            for (let i = scripts.length - 1; i >= 0; i--) {
                const code = scripts[i][1];
                if (code.includes('mg-player') || code.includes('jwplayer')) {
                    obfuscatedCode = code;
                    break;
                }
            }

            if (!obfuscatedCode) {
                continue;
            }

            // Define mock sandbox
            const mockElement = {
                getAttribute: function(name) {
                    if (name === 'data-id') return dataId;
                    if (name === 'data-realid') return dataRealId;
                    return null;
                },
                style: {},
                innerHTML: ""
            };

            const resultPromise = new Promise((rawResolve) => {
                // The player fetches its sources asynchronously, so give up after a
                // while instead of hanging forever when setup() is never reached.
                const timer = setTimeout(() => {
                    console.error(`Warning: ${target.name} timed out before the player called setup().`);
                    rawResolve(null);
                }, 25000);
                const resolve = function(config) {
                    clearTimeout(timer);
                    rawResolve(config);
                };

                const rawDocument = {
                    getElementById: function(id) {
                        if (id === 'mg-player') return mockElement;
                        return null;
                    },
                    querySelector: function(sel) {
                        if (sel === '#mg-player') return mockElement;
                        return null;
                    },
                    createElement: function() {
                        return { style: {} };
                    },
                    body: {
                        appendChild: function() {}
                    }
                };

                const mockLocalStorage = {
                    getItem: function(key) { return null; },
                    setItem: function(key, val) {},
                    removeItem: function(key) {},
                    clear: function() {}
                };

                // The player script patches HTMLVideoElement.prototype.canPlayType on
                // Safari-like user agents. Without this global it throws a ReferenceError.
                const mockHTMLVideoElement = function() {};
                mockHTMLVideoElement.prototype.canPlayType = function() { return 'probably'; };

                const playerInstanceMock = function(id) {
                    const playerInstance = {
                        setup: function(config) {
                            resolve(config);
                            return this;
                        },
                        on: function(event, callback) {
                            return this;
                        },
                        addButton: function() {
                            return this;
                        }
                    };
                    return playerInstance;
                };

                const mockNavigator = {
                    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
                };

                const rawWindow = {
                    location: {
                        href: embedUrl,
                        search: new URL(embedUrl).search
                    },
                    navigator: mockNavigator,
                    jwplayer: playerInstanceMock,
                    localStorage: mockLocalStorage,
                    addEventListener: function(event, callback) {},
                    removeEventListener: function(event, callback) {},
                    setInterval: function() { return 0; },
                    clearInterval: function() {},
                    setTimeout: function() { return 0; },
                    clearTimeout: function() {},
                    HTMLVideoElement: mockHTMLVideoElement
                };

                const sandbox = {
                    setInterval: function() { return 0; },
                    clearInterval: function() {},
                    setTimeout: function() { return 0; },
                    clearTimeout: function() {},
                    HTMLVideoElement: mockHTMLVideoElement,
                    // Read as a bare global (not just window.navigator) by the player script.
                    navigator: mockNavigator,
                    localStorage: mockLocalStorage,
                    URL: global.URL,
                    URLSearchParams: global.URLSearchParams,
                    fetch: function(input, init) {
                        let url = input;
                        if (typeof input === 'string' && !input.startsWith('http')) {
                            url = new URL(input, embedUrl).toString();
                        }
                        const options = init || {};
                        options.headers = options.headers || {};
                        options.headers['Referer'] = 'https://aniwaves.ru/';
                        options.headers['User-Agent'] = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
                        return global.fetch(url, options);
                    },
                    console: {
                        log: function() {},
                        error: function() {},
                        warn: function() {}
                    },
                    document: rawDocument,
                    window: rawWindow,
                    $: function(sel) {
                        return {
                            data: function(name) {
                                if (name === 'id') return dataId;
                                if (name === 'realid') return dataRealId;
                                return null;
                            },
                            attr: function(name) {
                                if (name === 'data-id') return dataId;
                                if (name === 'data-realid') return dataRealId;
                                return null;
                            },
                            html: function() { return this; },
                            hide: function() { return this; },
                            show: function() { return this; },
                            append: function() { return this; }
                        };
                    },
                    jwplayer: playerInstanceMock
                };

                sandbox.jQuery = sandbox.$;

                try {
                    vm.runInNewContext(obfuscatedCode, sandbox);
                } catch (e) {
                    // Report the reason but keep going: the player may still call
                    // setup() from an async callback that was already scheduled.
                    // Only the message -- the stack embeds the whole minified script.
                    console.error(`Warning: ${target.name} player script threw: ${e && e.name}: ${e && e.message}`);
                }
            });

            const playerConfig = await resultPromise;
            if (playerConfig) {
                output.results[target.name] = playerConfig;
            }
        }

        console.log(JSON.stringify(output, null, 2));

    } catch (e) {
        console.error(JSON.stringify({ error: e.message }));
    }
}

run();
