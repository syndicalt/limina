#!/usr/bin/env python3
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import os

HERE = "/tmp/claude-1000/-home-cheapseatsecon-Projects-Personal-limina/939e8bcb-f9c0-4315-896a-3ebbcbc4aa25/scratchpad"
FONT = os.path.join(HERE, "fonts", "Comfortaa.ttf")
HERO = "/home/cheapseatsecon/Projects/Personal/limina/assets/limina-hero.png"
OUT  = os.path.join(HERE, "limina-x-header.png")

S = 2                      # supersample factor
W, H = 1600 * S, 640 * S   # 5:2

def font(size, weight="Regular"):
    f = ImageFont.truetype(FONT, size * S)
    try: f.set_variation_by_name(weight)
    except Exception: pass
    return f

# ---- background: crop upper landscape band of the hero (avoids baked wordmark) ----
hero = Image.open(HERO).convert("RGB")
hw, hh = hero.size
crop_h = int(hw / 2.5)                 # 5:2 band at full width
band = hero.crop((0, 0, hw, crop_h))
bg = band.resize((W, H), Image.LANCZOS).convert("RGBA")

# ---- legibility scrims ----
ov = Image.new("RGBA", (W, H), (0, 0, 0, 0))
od = ImageDraw.Draw(ov)
# gentle top darkening
for y in range(H):
    t = y / H
    top = int(70 * max(0, 1 - t * 3.2))            # darken very top
    bot = int(205 * max(0, (t - 0.46) / 0.54)) if t > 0.46 else 0  # darken toward bottom
    a = min(225, top + bot)
    od.line([(0, y), (W, y)], fill=(6, 8, 18, a))
bg = Image.alpha_composite(bg, ov)
# soft centered glow behind wordmark for contrast
glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
gd = ImageDraw.Draw(glow)
gd.ellipse([W*0.14, H*0.08, W*0.86, H*0.68], fill=(8, 10, 26, 135))
glow = glow.filter(ImageFilter.GaussianBlur(130 * S))
bg = Image.alpha_composite(bg, glow)

draw = ImageDraw.Draw(bg)

def tracked_width(text, fnt, tracking):
    w = 0
    for ch in text:
        w += draw.textlength(ch, font=fnt) + tracking * S
    return w - tracking * S

def draw_tracked(xy, text, fnt, fill, tracking, anchor_center=True):
    x, y = xy
    if anchor_center:
        x -= tracked_width(text, fnt, tracking) / 2
    for ch in text:
        draw.text((x, y), ch, font=fnt, fill=fill)
        x += draw.textlength(ch, font=fnt) + tracking * S
    return x

# ---- "limina" wordmark with vertical pastel gradient + glow ----
wm = "limina"
fwm = font(158, "Bold")
bbox = draw.textbbox((0, 0), wm, font=fwm)
tw, th = bbox[2]-bbox[0], bbox[3]-bbox[1]
# render white mask
mask = Image.new("L", (tw + 40*S, th + 60*S), 0)
ImageDraw.Draw(mask).text((20*S - bbox[0], 20*S - bbox[1]), wm, font=fwm, fill=255)
# vertical gradient (light lilac -> periwinkle), with a touch of pink to the right
grad = Image.new("RGBA", mask.size, (0,0,0,0))
gpx = grad.load()
gw, gh = mask.size
c_top = (244, 236, 252)   # white-lilac
c_mid = (197, 174, 240)   # lilac
c_bot = (124, 151, 238)   # periwinkle blue
def lerp(a,b,t): return tuple(int(a[i]+(b[i]-a[i])*t) for i in range(3))
for y in range(gh):
    t = y/gh
    col = lerp(c_top, c_mid, t/0.5) if t < 0.5 else lerp(c_mid, c_bot, (t-0.5)/0.5)
    for x in range(gw):
        gpx[x, y] = (*col, 255)
grad.putalpha(mask)
# glow
gl = grad.filter(ImageFilter.GaussianBlur(10*S))
wm_x = (W - gw)//2
wm_y = int(H*0.18)
bg.alpha_composite(gl, (wm_x, wm_y))
bg.alpha_composite(grad, (wm_x, wm_y))

# baseline reference for items below
wm_bottom = wm_y + 20*S + (th)  # approx glyph bottom

draw = ImageDraw.Draw(bg)
# ---- "engine" tracked, light ----
feng = font(60, "Light")
draw_tracked((W/2, wm_bottom + 6*S), "engine", feng, (205, 197, 226, 255), tracking=24)

# ---- tagline (with its own soft scrim so it stays legible over the horizon) ----
ftag = font(26, "Regular")
tag = "build worlds by talking to an agent  ·  run them anywhere"
tag_y = wm_bottom + 94*S
tag_w = tracked_width(tag, ftag, 3)
scr = Image.new("RGBA", (W, H), (0,0,0,0))
ImageDraw.Draw(scr).rounded_rectangle(
    [W/2 - tag_w/2 - 40*S, tag_y - 12*S, W/2 + tag_w/2 + 40*S, tag_y + 44*S],
    radius=28*S, fill=(6, 8, 18, 150))
scr = scr.filter(ImageFilter.GaussianBlur(18*S))
bg = Image.alpha_composite(bg, scr)
draw = ImageDraw.Draw(bg)
draw_tracked((W/2, tag_y), tag, ftag, (208, 216, 238, 255), tracking=3)

# ---- bottom feature bar ----
bar_top = int(H*0.80)
barov = Image.new("RGBA", (W, H), (0,0,0,0))
bd = ImageDraw.Draw(barov)
for y in range(bar_top, H):
    t = (y - bar_top)/(H - bar_top)
    bd.line([(0,y),(W,y)], fill=(4,6,16, int(120 + 90*t)))
bg = Image.alpha_composite(bg, barov)
draw = ImageDraw.Draw(bg)

ICON = (134, 197, 232, 255)
LBL  = (214, 221, 236, 255)
flbl = font(19, "SemiBold")
cy = int(H*0.895)              # label baseline-ish
iy = cy - 6*S                  # icon center y
feats = ["AGENT-NATIVE", "MCP-DRIVEN", "REAL-TIME WEBGPU", "TYPED & TRACED"]
# four equal columns
col_w = W / 4
def icon_diamond(cx):
    r = 13*S
    draw.line([(cx,iy-r),(cx+r,iy),(cx,iy+r),(cx-r,iy),(cx,iy-r)], fill=ICON, width=2*S)
    r2 = 6*S
    draw.line([(cx,iy-r2),(cx+r2,iy),(cx,iy+r2),(cx-r2,iy),(cx,iy-r2)], fill=ICON, width=2*S)
def icon_code(cx):
    fc = font(28, "Bold")
    w = draw.textlength("</>", font=fc)
    draw.text((cx - w/2, iy - 19*S), "</>", font=fc, fill=ICON)
def icon_cube(cx):
    r = 13*S; h = 7*S
    top=[(cx,iy-r),(cx+r,iy-r+h),(cx,iy-r+2*h),(cx-r,iy-r+h)]
    draw.line(top+[top[0]], fill=ICON, width=2*S)
    draw.line([(cx-r,iy-r+h),(cx-r,iy+h),(cx,iy+2*h),(cx,iy-r+2*h)], fill=ICON, width=2*S)
    draw.line([(cx+r,iy-r+h),(cx+r,iy+h),(cx,iy+2*h)], fill=ICON, width=2*S)
def icon_pulse(cx):
    r=15*S
    pts=[(cx-r,iy),(cx-r*0.4,iy),(cx-r*0.15,iy-r*0.7),(cx+r*0.15,iy+r*0.7),(cx+r*0.4,iy),(cx+r,iy)]
    draw.line(pts, fill=ICON, width=2*S, joint="curve")
icons=[icon_diamond, icon_code, icon_cube, icon_pulse]
for i,(lbl,ic) in enumerate(zip(feats, icons)):
    cx = int(col_w*(i+0.5))
    ic(cx)
    draw_tracked((cx, cy + 10*S), lbl, flbl, LBL, tracking=3)
    # thin divider
    if i < 3:
        dx = int(col_w*(i+1))
        draw.line([(dx, cy-8*S),(dx, cy+28*S)], fill=(255,255,255,40), width=1*S)

# ---- downsample for crisp anti-aliased result ----
final = bg.convert("RGB").resize((1600, 640), Image.LANCZOS)
final.save(OUT, "PNG")
print("wrote", OUT, final.size)
