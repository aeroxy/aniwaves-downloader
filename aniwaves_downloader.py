import os
import sys
import json
import subprocess
import requests
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urljoin, urlparse

# Disable urllib3 insecure request warnings since we are using verify=False
import urllib3
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

def run_node_extractor(url):
    """Executes the Node.js extractor script as a subprocess and parses the JSON result."""
    print(f"Running Node extractor for: {url}...")
    try:
        # Resolve path to aniwaves_extractor.js
        script_dir = os.path.dirname(os.path.abspath(__file__))
        extractor_path = os.path.join(script_dir, "aniwaves_extractor.js")
        
        result = subprocess.run(
            ["node", extractor_path, url],
            capture_output=True,
            text=True,
            check=True
        )
        
        # Parse output (skip any non-JSON lines like warnings from Node)
        stdout_lines = result.stdout.strip().split("\n")
        json_str = ""
        for line in stdout_lines:
            if line.strip().startswith("{") or json_str:
                json_str += line + "\n"
        
        if not json_str:
            print("Error: Extractor did not return valid JSON.", file=sys.stderr)
            print("Stdout:", result.stdout, file=sys.stderr)
            print("Stderr:", result.stderr, file=sys.stderr)
            return None
            
        return json.loads(json_str)
    except Exception as e:
        print(f"Error executing Node extractor: {e}", file=sys.stderr)
        return None

def download_subtitles(tracks, base_name):
    """Finds and downloads the English .srt subtitles track if available."""
    if not tracks:
        print("No subtitles tracks found.")
        return None
        
    # Find ENG or English track
    eng_track = None
    for track in tracks:
        if track.get("label") == "ENG" or "english" in track.get("label", "").lower():
            eng_track = track
            break
            
    if not eng_track:
        # Fallback to the first track marked default
        for track in tracks:
            if track.get("default"):
                eng_track = track
                break
                
    if not eng_track and len(tracks) > 0:
        # Ultimate fallback to first track
        eng_track = tracks[0]
        
    if not eng_track:
        print("No English or default subtitles track found.")
        return None
        
    sub_url = eng_track["file"]
    sub_label = eng_track.get("label", "Subtitles")
    sub_filename = os.path.join("downloads", f"{base_name}_{sub_label}.srt")
    
    # Create downloads directory if it doesn't exist
    if not os.path.exists("downloads"):
        os.makedirs("downloads")
    
    print(f"Downloading {sub_label} subtitles from: {sub_url}...")
    try:
        r = requests.get(sub_url, verify=False, timeout=30)
        r.raise_for_status()
        with open(sub_filename, "w", encoding="utf-8") as f:
            f.write(r.text)
        print(f"Subtitles downloaded successfully: {sub_filename}")
        return sub_filename
    except Exception as e:
        print(f"Failed to download subtitles: {e}")
        return None

def select_best_resolution(master_m3u8_url, referer):
    """Downloads the master m3u8 playlist, parses resolutions, and selects the highest one."""
    print("Fetching master playlist to select best resolution...")
    headers = {
        "Referer": referer,
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
    }
    try:
        r = requests.get(master_m3u8_url, headers=headers, verify=False, timeout=30)
        r.raise_for_status()
        
        lines = r.text.strip().split("\n")
        streams = []
        current_stream_info = None
        
        for line in lines:
            line = line.strip()
            if line.startswith("#EXT-X-STREAM-INF"):
                current_stream_info = line
            elif line and not line.startswith("#") and current_stream_info:
                # Find resolution inside STREAM-INF
                res_match = None
                # Search for RESOLUTION=1920x1080 or NAME="1080"
                if "RESOLUTION=" in current_stream_info:
                    parts = current_stream_info.split("RESOLUTION=")
                    res_val = parts[1].split(",")[0]
                    res_match = res_val
                elif "NAME=" in current_stream_info:
                    parts = current_stream_info.split("NAME=\"")
                    res_val = parts[1].split("\"")[0]
                    res_match = res_val
                    
                # Construct absolute URL
                stream_url = line
                if not stream_url.startswith("http"):
                    stream_url = urljoin(master_m3u8_url, stream_url)
                    
                streams.append({
                    "resolution": res_match or "Unknown",
                    "url": stream_url
                })
                current_stream_info = None
                
        if not streams:
            print("No streams found in master playlist. Returning original URL.")
            return master_m3u8_url
            
        print("Available resolutions:")
        for idx, s in enumerate(streams):
            print(f" [{idx + 1}] Resolution: {s['resolution']}")
            
        # Automatically select the highest resolution (usually the last or highest resolution string)
        # Sort resolutions: 1080 > 720 > 360 etc.
        def get_res_height(stream):
            res = stream["resolution"]
            if "x" in res:
                return int(res.split("x")[1])
            try:
                return int(res)
            except:
                return 0
                
        streams.sort(key=get_res_height, reverse=True)
        best_stream = streams[0]
        print(f"Selected highest resolution: {best_stream['resolution']}")
        return best_stream["url"]
        
    except Exception as e:
        print(f"Failed to parse master playlist: {e}. Defaulting to original stream URL.")
        return master_m3u8_url

def download_segment(segment_info):
    """Downloads a single .ts segment with retry mechanism."""
    idx, segment_url, base_url, referer, segment_prefix = segment_info
    session = requests.Session()
    session.headers.update({
        "Referer": referer,
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Priority": "u=1, i"
    })
    
    if not segment_url.startswith("http"):
        segment_url = urljoin(base_url, segment_url)
        
    parsed_url = urlparse(segment_url)
    if parsed_url.hostname:
        session.headers["Host"] = parsed_url.hostname
        
    filename = f"{segment_prefix}_segment_{idx:04d}.ts"
    
    for attempt in range(3):
        try:
            r = session.get(segment_url, timeout=30, verify=False)
            r.raise_for_status()
            with open(filename, "wb") as f:
                f.write(r.content)
            return (idx, filename)
        except Exception as e:
            if attempt < 2:
                import time
                time.sleep(1)
            else:
                print(f"Failed to download segment {idx + 1} after 3 attempts: {e}")
                return (idx, None)

def download_stream(stream_m3u8_url, referer, output_filename, segment_prefix):
    """Downloads all segments from m3u8 playlist and combines them into final video file."""
    headers = {
        "Referer": referer,
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
    }
    try:
        r = requests.get(stream_m3u8_url, headers=headers, verify=False, timeout=30)
        r.raise_for_status()
        
        lines = r.text.strip().split("\n")
        segments = []
        for line in lines:
            line = line.strip()
            if line and not line.startswith("#"):
                segments.append(line)
                
        total_segments = len(segments)
        print(f"Found {total_segments} segments to download...")
        
        # Download concurrently using ThreadPoolExecutor
        segment_files = [None] * total_segments
        failed_segments = []
        max_workers = 10
        
        # Construct task list
        tasks = [
            (i, seg_url, stream_m3u8_url, referer, segment_prefix)
            for i, seg_url in enumerate(segments)
        ]
        
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            future_to_segment = {
                executor.submit(download_segment, task): task[0]
                for task in tasks
            }
            
            for future in as_completed(future_to_segment):
                idx = future_to_segment[future]
                idx_res, filename = future.result()
                if filename:
                    segment_files[idx_res] = filename
                else:
                    failed_segments.append(idx_res)
                    
        # Retry failed segments
        if failed_segments:
            print(f"Retrying {len(failed_segments)} failed segments...")
            for idx in failed_segments:
                task = tasks[idx]
                idx_res, filename = download_segment(task)
                if filename:
                    segment_files[idx_res] = filename
                else:
                    print(f"Critical error: segment {idx + 1} failed to download.")
                    return False
                    
        # Create local.m3u8 playlist file
        local_m3u8_path = f"{segment_prefix}_local.m3u8"
        with open(local_m3u8_path, "w", encoding="utf-8") as f:
            segment_idx = 0
            for line in lines:
                line = line.strip()
                if not line:
                    continue
                if line.startswith("#"):
                    f.write(line + "\n")
                else:
                    f.write(f"{segment_files[segment_idx]}\n")
                    segment_idx += 1
                    
        print(f"Created local playlist: {local_m3u8_path}")
        print("Combining segments into final MP4 video file...")
        
        # Run ffmpeg to combine segments
        cmd = [
            "ffmpeg", "-y",
            "-allowed_extensions", "ALL",
            "-protocol_whitelist", "file,http,https,tcp,tls,crypto",
            "-i", local_m3u8_path,
            "-c", "copy",
            output_filename
        ]
        
        print("Running:", " ".join(cmd))
        res = subprocess.run(cmd, capture_output=True, text=True)
        
        # Clean up segments and local m3u8
        os.remove(local_m3u8_path)
        for seg_file in segment_files:
            if seg_file and os.path.exists(seg_file):
                os.remove(seg_file)
                
        if res.returncode == 0:
            print(f"Video compiled successfully: {output_filename}")
            return True
        else:
            print(f"FFmpeg failed with code {res.returncode}", file=sys.stderr)
            print("FFmpeg Stderr:", res.stderr, file=sys.stderr)
            return False
            
    except Exception as e:
        print(f"Failed to download stream: {e}")
        return False

def main():
    if len(sys.argv) > 1:
        watch_url = sys.argv[1]
    else:
        watch_url = input("Enter aniwaves.ru Watch URL: ").strip()
        if not watch_url:
            print("Error: No watch URL provided.", file=sys.stderr)
            sys.exit(1)
            
    print(f"\n=================== ANIWAVES DOWNLOADER ===================")
    print(f"Watch URL: {watch_url}")
    
    # Run Node extractor
    data = run_node_extractor(watch_url)
    if not data:
        print("Extraction failed. Exiting.")
        return
        
    slug = data.get("animeSlug", "anime")
    episode = data.get("episode", "1")
    results = data.get("results", {})
    
    base_name = f"{slug.replace('-', '_')}_Ep_{episode}"
    
    # 1. Download ENG Subtitles if Soft-sub is available
    ssub_config = results.get("S-SUB")
    subtitles_file = None
    if ssub_config and "tracks" in ssub_config:
        subtitles_file = download_subtitles(ssub_config["tracks"], base_name)
    else:
        print("S-SUB MyCloud server not found, soft subtitles are unavailable.")
        
    # 2. Extract and download the best resolution video stream
    # Preference: DUB, then SUB, then S-SUB, then first available
    stream_name = None
    stream_config = None
    for pref in ["DUB", "SUB", "S-SUB"]:
        if pref in results:
            stream_name = pref
            stream_config = results[pref]
            break
            
    if not stream_config and results:
        stream_name = list(results.keys())[0]
        stream_config = results[stream_name]
        
    if not stream_config or "sources" not in stream_config or len(stream_config["sources"]) == 0:
        print("No playable video sources found in configuration.")
        return
        
    master_m3u8_url = stream_config["sources"][0]["file"]
    print(f"\nFound {stream_name} video stream master URL: {master_m3u8_url}")
    
    # We will use play.echovideo.ru as referer for .m3u8 requests
    # Wait, the play.echovideo.ru URL can be mapped from S-SUB or DUB embed url
    # Let's use https://play.echovideo.ru/ as standard referer
    referer = "https://play.echovideo.ru/"
    
    # Resolve highest resolution stream
    best_stream_url = select_best_resolution(master_m3u8_url, referer)
    
    # Final video filename
    video_filename = os.path.join("downloads", f"{base_name}_{stream_name}.mp4")
    segment_prefix = f"temp_{base_name}_{stream_name}"
    
    # Create downloads directory if it doesn't exist
    if not os.path.exists("downloads"):
        os.makedirs("downloads")
        
    print(f"\nDownloading video to: {video_filename}...")
    success = download_stream(best_stream_url, referer, video_filename, segment_prefix)
    
    print(f"\n=================== DOWNLOAD COMPLETE ===================")
    if success:
        print(f"Video file: {video_filename}")
        if subtitles_file:
            print(f"Subtitles file: {subtitles_file}")
            print("\nDownloaded successfully! You can play the .mp4 file alongside the .srt subtitle track.")
        else:
            print("\nDownloaded successfully (no external soft-subtitles downloaded).")
    else:
        print("Download failed during video segment download/compilation.", file=sys.stderr)

if __name__ == "__main__":
    main()
