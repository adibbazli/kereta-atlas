"""Generate the PWA / iOS home-screen icons into frontend/public/icons/.

Dev-only (needs Pillow: `.venv/bin/pip install pillow`). Same mark as favicon.svg: a white car on a
near-black tile. Drawn at 4x and downscaled for smooth edges.

    .venv/bin/python tools/make_icons.py
"""

from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "frontend" / "public" / "icons"
BG = (17, 17, 17, 255)
FG = (255, 255, 255, 255)


def draw(size: int, *, rounded: bool, safe: float) -> Image.Image:
    """`safe` shrinks the car toward the centre (maskable icons get cropped to a circle)."""
    s = size * 4
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if rounded:
        d.rounded_rectangle((0, 0, s - 1, s - 1), radius=int(s * 0.22), fill=BG)
    else:
        d.rectangle((0, 0, s, s), fill=BG)

    # Car from favicon.svg, in a 32-unit box: body y 12..23, wheels at y 18.5.
    k = s / 32 * safe
    off = (s - 32 * k) / 2
    # The car spans y 12..23 (centre 17.5); shift it up so it sits in the middle of the tile.
    p = lambda x, y: (off + x * k, off + (y - 1.5) * k)  # noqa: E731
    d.polygon([p(8, 19), p(10.2, 13.4), p(12.1, 12), p(19.9, 12), p(21.8, 13.4), p(24, 19), p(24, 23),
               p(21.5, 23), p(21.5, 21), p(10.5, 21), p(10.5, 23), p(8, 23)], fill=FG)
    for cx in (11.5, 20.5):
        r = 1.3 * k
        x, y = p(cx, 18.5)
        d.ellipse((x - r, y - r, x + r, y + r), fill=BG)
    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    # iOS rounds the corners itself, so the touch icon is a full square.
    draw(180, rounded=False, safe=1.05).convert("RGB").save(OUT / "apple-touch-icon.png")
    draw(192, rounded=True, safe=1.0).save(OUT / "icon-192.png")
    draw(512, rounded=True, safe=1.0).save(OUT / "icon-512.png")
    draw(512, rounded=False, safe=0.8).save(OUT / "icon-maskable-512.png")
    print("wrote", sorted(p.name for p in OUT.iterdir()))


if __name__ == "__main__":
    main()
