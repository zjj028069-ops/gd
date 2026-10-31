"""Usage: python scripts/render-icons.py public

Render frontend/public/icon.svg to PNG sizes + a Windows .ico via headless Edge."""
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image

EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
pub = Path(sys.argv[1])
svg = (pub / "icon.svg").read_text(encoding="utf-8")
small_svg = (pub / "icon-small.svg").read_text(encoding="utf-8")
tmp = Path(tempfile.mkdtemp())

def render(size: int, pad: float = 0.0, src: str | None = None) -> Image.Image:
    src = src or svg
    inner = int(size * (1 - 2 * pad))
    off = (size - inner) // 2
    html = tmp / f"i{size}.html"
    html.write_text(
        f"<html><body style='margin:0;background:transparent'>"
        f"<img src='data:image/svg+xml;utf8,{src.replace(chr(35), '%23').replace(chr(10), ' ')}' "
        f"style='position:absolute;left:{off}px;top:{off}px;width:{inner}px;height:{inner}px'></body></html>",
        encoding="utf-8")
    out = tmp / f"i{size}.png"
    subprocess.run([EDGE, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1", "--default-background-color=00000000", f"--user-data-dir={tmp / 'profile'}",
                    f"--window-size={size + 400},{size + 400}", f"--screenshot={out}", html.as_uri()],
                   check=True, capture_output=True, timeout=60)
    return Image.open(out).convert("RGBA").crop((0, 0, size, size))

big = render(1024)
for s in (512, 192, 180, 32):
    big.resize((s, s), Image.LANCZOS).save(pub / f"icon-{s}.png")
# Small sizes use the simplified mark; large sizes the full artwork.
small = render(1024, src=small_svg)
frames = [small.resize((s, s), Image.LANCZOS) for s in (16, 24, 32, 48)] + [big.resize((s, s), Image.LANCZOS) for s in (64, 128, 256)]
frames[-1].save(pub / "favicon.ico", sizes=[f.size for f in frames], append_images=frames[:-1])
small.resize((32, 32), Image.LANCZOS).save(pub / "icon-32.png")
print("ok", [p.name for p in pub.iterdir()])
