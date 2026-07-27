#!/usr/bin/env python3
"""Burn short captions into a demo video so it reads without narration.

Usage: _caption_video.py <in> <out> "start-end:text" ...
"""
import subprocess
import sys

FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"


def esc(text):
    """Escape for a single-quoted drawtext argument.

    Apostrophes cannot be escaped reliably inside the quoted form, so they are
    swapped for a typographic quote — which reads better on screen anyway.
    """
    return (text.replace("\\", r"\\")
                .replace("'", "’")
                .replace(":", r"\:")
                .replace("%", r"\%"))


def main():
    src, out, specs = sys.argv[1], sys.argv[2], sys.argv[3:]
    parts = []
    for spec in specs:
        rng, text = spec.split(":", 1)
        start, end = rng.split("-")
        between = f"between(t,{start},{end})"
        parts.append(
            f"drawbox=y=ih-100:h=68:t=fill:color=black@0.75:enable='{between}'"
        )
        parts.append(
            f"drawtext=fontfile={FONT}:text='{esc(text)}':fontcolor=white:"
            f"fontsize=25:x=(w-text_w)/2:y=h-80:enable='{between}'"
        )
    cmd = [
        "ffmpeg", "-y", "-loglevel", "error", "-i", src,
        "-vf", ",".join(parts),
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "25", "-preset", "slow",
        "-an", out,
    ]
    subprocess.run(cmd, check=True)
    dur = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "csv=p=0", out],
        capture_output=True, text=True, check=True).stdout.strip()
    print(f"{out} ({dur}s)")


if __name__ == "__main__":
    main()
