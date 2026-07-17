process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const https = require('https');
const vm = require('vm');

const watchUrl = process.argv[2];
if (!watchUrl) {
    console.error(JSON.stringify({ error: "No watch URL provided as an argument" }));
    process.exit(1);
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
        const serverListJson = JSON.parse(serverListRaw);
        
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
            const sourcesJson = JSON.parse(sourcesRaw);

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

            const resultPromise = new Promise((resolve) => {
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

                const rawWindow = {
                    location: {
                        href: embedUrl,
                        search: new URL(embedUrl).search
                    },
                    navigator: {
                        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
                    },
                    jwplayer: playerInstanceMock,
                    localStorage: mockLocalStorage,
                    addEventListener: function(event, callback) {},
                    removeEventListener: function(event, callback) {}
                };

                const sandbox = {
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
                    const modifiedCode = obfuscatedCode.replace(
                        "d[aM('W1WH',0x230,0x8b2,0x4a6,0xc6)+aI(0xc9d,0x937,'6dQ8',0x5e9,0xa0b)+'l']",
                        "(() => {})"
                    );
                    vm.runInNewContext(modifiedCode, sandbox);
                } catch (e) {
                    // Ignore execution errors
                }
            });

            const playerConfig = await resultPromise;
            output.results[target.name] = playerConfig;
        }

        console.log(JSON.stringify(output, null, 2));

    } catch (e) {
        console.error(JSON.stringify({ error: e.message }));
    }
}

run();
