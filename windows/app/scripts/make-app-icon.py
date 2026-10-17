# 설치 파일·앱 아이콘(assets/app.ico)을 맥판 AppIcon.icns 에서 만든다. 한 번 만들어 저장소에 넣어 두고, 맥 아이콘이 바뀔 때만 다시 돌린다.
# 사용: python scripts/make-app-icon.py <맥판 Resources/AppIcon.icns>   (Pillow 필요)
# 맥 아이콘은 둥근 판 둘레에 투명 여백이 넓어서, 판에 맞춰 잘라 Windows 아이콘처럼 칸을 채운다.
import sys
from pathlib import Path

from PIL import Image

src = Path(sys.argv[1])
out = Path(__file__).resolve().parent.parent / "assets" / "app.ico"
im = Image.open(src)
im.load()
im = im.convert("RGBA")
box = im.getchannel("A").getbbox()
side = max(box[2] - box[0], box[3] - box[1])
cx, cy = (box[0] + box[2]) // 2, (box[1] + box[3]) // 2
square = im.crop((cx - side // 2, cy - side // 2, cx + side // 2, cy + side // 2))
sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
square.resize((256, 256), Image.LANCZOS).save(out, sizes=[(s, s) for s in sizes])
print(f"{out} ({', '.join(map(str, sizes))})")
