# The montage's end card and the before/after still, in $STEVE Craft's look (KenneyMini, white with a dark drop
# shadow, yellow highlight), over a frame from the game.
#   python card.py endcard <background.png> <out.png>          1920x1080: "$STEVE Craft / now survival / stevepumpfun.com/play"
#   python card.py beforeafter <before.png> <after.png> <out.png>   2400x1350 side by side, labelled
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter, ImageEnhance, ImageFont

FONT = str(Path(__file__).resolve().parents[2] / "web" / "public" / "play" / "fonts" / "KenneyMini.ttf")


def font(px):
    return ImageFont.truetype(FONT, px)


def shadow_text(d, xy, text, f, fill, shadow=(63, 63, 63), off=None, anchor="mm"):
    off = off or max(2, f.size // 9)
    d.text((xy[0] + off, xy[1] + off), text, font=f, fill=shadow, anchor=anchor)
    d.text(xy, text, font=f, fill=fill, anchor=anchor)


def endcard(bg, out):
    im = Image.open(bg).convert("RGB").resize((1920, 1080), Image.LANCZOS)
    im = im.filter(ImageFilter.GaussianBlur(10))
    im = ImageEnhance.Brightness(im).enhance(0.42)
    d = ImageDraw.Draw(im)
    shadow_text(d, (960, 430), "$STEVE Craft", font(150), (255, 255, 255), off=12)
    shadow_text(d, (960, 585), "now survival", font(84), (255, 255, 85), shadow=(63, 63, 0), off=8)
    shadow_text(d, (960, 735), "stevepumpfun.com/play", font(58), (230, 230, 230), off=6)
    im.save(out)


def crop_center(im, w, h, cx=None):
    cx = im.width // 2 if cx is None else cx
    x0 = max(0, min(im.width - w, cx - w // 2))
    y0 = (im.height - h) // 2
    return im.crop((x0, y0, x0 + w, y0 + h))


def beforeafter(before, after, out, bx=None, ax=None):
    W, H = 2400, 1350
    a = Image.open(before).convert("RGB").resize((W, H), Image.LANCZOS)
    b = Image.open(after).convert("RGB").resize((W, H), Image.LANCZOS)
    left = crop_center(a, W // 2, H, bx)
    right = crop_center(b, W // 2, H, ax)
    im = Image.new("RGB", (W, H))
    im.paste(left, (0, 0))
    im.paste(right, (W // 2, 0))
    d = ImageDraw.Draw(im, "RGBA")
    d.rectangle((W // 2 - 4, 0, W // 2 + 3, H), fill=(0, 0, 0, 255))
    d.rectangle((W // 2 - 1, 0, W // 2, H), fill=(255, 255, 85, 255))
    for x0, title, sub in [(0, "BEFORE", "the builder"), (W // 2, "NOW", "survival")]:
        d.rectangle((x0 + 40, 40, x0 + 520, 230), fill=(0, 0, 0, 140))
        shadow_text(d, (x0 + 80, 95), title, font(78), (255, 255, 85) if title == "NOW" else (255, 255, 255), anchor="lm")
        shadow_text(d, (x0 + 80, 180), sub, font(52), (230, 230, 230), anchor="lm")
    d.rectangle((W // 2 - 520, H - 120, W // 2 + 520, H - 40), fill=(0, 0, 0, 150))
    shadow_text(d, (W // 2, H - 80), "$STEVE Craft  ·  stevepumpfun.com/play", font(46), (255, 255, 255))
    im.save(out)


if __name__ == "__main__":
    if sys.argv[1] == "endcard":
        endcard(sys.argv[2], sys.argv[3])
    else:
        bx = int(sys.argv[5]) if len(sys.argv) > 5 else None
        ax = int(sys.argv[6]) if len(sys.argv) > 6 else None
        beforeafter(sys.argv[2], sys.argv[3], sys.argv[4], bx, ax)
