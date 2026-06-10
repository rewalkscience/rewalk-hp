from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageFilter


ROOT = Path(__file__).resolve().parent
ASSET_DIR = ROOT / "assets"
LOGO_PATH = ASSET_DIR / "logo" / "rewalk-logo-horizontal.png"
BG_DIR = Path(r"C:\Users\tamun\.codex\generated_images\019e94c1-7132-7d12-b9ca-714edc200675")
BG_PATH = BG_DIR / "ig_0e86a596d74be9aa016a21fd24afbc819188e959c84cea8132.png"
if not BG_PATH.exists():
    BG_PATH = next(BG_DIR.glob("*.png"))
OUT_DIR = ROOT / "output" / "sponsor-banner"
OUT_DIR.mkdir(parents=True, exist_ok=True)

W, H = 200, 50
SCALE = 4


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    candidates = [
        r"C:\Windows\Fonts\YuGothB.ttc" if bold else r"C:\Windows\Fonts\YuGothM.ttc",
        r"C:\Windows\Fonts\meiryob.ttc" if bold else r"C:\Windows\Fonts\meiryo.ttc",
        r"C:\Windows\Fonts\NotoSansCJKjp-Bold.otf" if bold else r"C:\Windows\Fonts\NotoSansCJKjp-Regular.otf",
    ]
    for path in candidates:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def fit_text(draw: ImageDraw.ImageDraw, text: str, max_width: int, start_size: int, bold: bool) -> ImageFont.FreeTypeFont:
    size = start_size
    while size > 6:
        f = font(size, bold)
        bbox = draw.textbbox((0, 0), text, font=f)
        if bbox[2] - bbox[0] <= max_width:
            return f
        size -= 1
    return font(size, bold)


def resize_cover(img: Image.Image, size: tuple[int, int]) -> Image.Image:
    src_w, src_h = img.size
    dst_w, dst_h = size
    ratio = max(dst_w / src_w, dst_h / src_h)
    new_size = (int(src_w * ratio), int(src_h * ratio))
    img = img.resize(new_size, Image.Resampling.LANCZOS)
    left = (img.width - dst_w) // 2
    top = (img.height - dst_h) // 2
    return img.crop((left, top, left + dst_w, top + dst_h))


def make_banner(scale: int = 1) -> Image.Image:
    w, h = W * scale, H * scale
    bg = resize_cover(Image.open(BG_PATH).convert("RGB"), (w, h))
    bg = bg.filter(ImageFilter.GaussianBlur(radius=0.45 * scale))

    # White wash keeps the tiny sponsor banner readable.
    wash = Image.new("RGBA", (w, h), (255, 255, 255, 210))
    banner = Image.alpha_composite(bg.convert("RGBA"), wash)
    draw = ImageDraw.Draw(banner)

    navy = (17, 53, 96, 255)
    blue = (25, 103, 210, 255)
    pale = (221, 237, 255, 255)
    cyan = (43, 178, 215, 210)

    # Scientific gait accent, kept quiet enough for the 20KB upload limit.
    draw.line([(0, int(41 * scale)), (w, int(36 * scale)), (w, int(45 * scale))], fill=pale, width=max(1, 2 * scale))
    for x in [118, 136, 154, 172]:
        draw.ellipse((x * scale, 8 * scale, (x + 3) * scale, 11 * scale), fill=cyan)
    draw.line([(120 * scale, 10 * scale), (138 * scale, 20 * scale), (157 * scale, 15 * scale), (178 * scale, 28 * scale)], fill=(70, 144, 205, 120), width=max(1, scale))

    # Logo block.
    logo = Image.open(LOGO_PATH).convert("RGBA")
    target_w = int(78 * scale)
    ratio = target_w / logo.width
    logo = logo.resize((target_w, int(logo.height * ratio)), Image.Resampling.LANCZOS)
    lx = int(8 * scale)
    ly = (h - logo.height) // 2
    banner.alpha_composite(logo, (lx, ly))

    draw.rounded_rectangle(
        (86 * scale, 9 * scale, 197 * scale, 42 * scale),
        radius=4 * scale,
        fill=(255, 255, 255, 170),
        outline=(205, 224, 246, 180),
        width=max(1, scale),
    )

    main = "歩行を、科学する。"
    sub = "オンラインセミナー開催中"
    main_font = fit_text(draw, main, int(102 * scale), int(14 * scale), True)
    sub_font = fit_text(draw, sub, int(102 * scale), int(8 * scale), True)
    draw.text((91 * scale, 12 * scale), main, font=main_font, fill=navy)
    draw.text((92 * scale, 30 * scale), sub, font=sub_font, fill=blue)

    return banner.convert("RGB")


def optimize_png(img: Image.Image, path: Path) -> None:
    img.save(path, optimize=True)
    # Palette PNG is smaller and sufficient for this small banner.
    if path.stat().st_size > 20 * 1024:
        pal = img.convert("P", palette=Image.Palette.ADAPTIVE, colors=96)
        pal.save(path, optimize=True)


banner = make_banner(1)
final_path = OUT_DIR / "rewalk-sponsor-banner-200x50.png"
optimize_png(banner, final_path)

preview = make_banner(SCALE)
preview_path = OUT_DIR / "rewalk-sponsor-banner-preview-800x200.png"
preview.save(preview_path, optimize=True)

print(final_path)
print(final_path.stat().st_size)
print(preview_path)
