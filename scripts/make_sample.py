"""Create the original, redistributable welcome EPUB. No third-party book content."""
from pathlib import Path
from zipfile import ZipFile, ZIP_STORED, ZIP_DEFLATED
from html import escape

ROOT = Path(__file__).resolve().parents[1]
CHAPTERS = [
    ("给阅读留一盏灯", [
        "傍晚的光从窗边慢慢退去，桌上的书还停在昨天折起的那一页。你不必急着读完它。把手机放远一些，倒一杯温水，世界就可以暂时缩小到一行文字。",
        "阅读有一种特别的节奏。它允许停顿，允许回头，允许一个句子在心里多停留一会儿。与其追赶进度，不如找到一个舒服的位置，让故事自己往前走。",
        "这是 DR Reader 的第一本书，也是一个小小的开始。左边是目录，右边是可以安静阅读的正文。你可以改变字号、行距与纸张颜色，也可以在喜欢的地方留下一枚书签。",
        "当你合上这本书，阅读的位置会保存在本机。下次回来，你依然可以从这里出发。",
        "你自己的书架，等待着第一本真正想读的书。点击“书库”，再选择“添加图书”，把一份 EPUB 放进来。它的文字、插图与章节会在电脑里整理好，等待你打开。",
    ]),
    ("把一页读成一段时光", [
        "有些书适合清晨读，有些书适合在雨声里读。有些句子要读得很慢，才能听见它没有直接说出的那一部分。",
        "如果你更习惯纸书的节奏，可以在阅读设置里选择左右翻页。上下滚动则适合长篇文字，像一条缓缓展开的河流。两种方式都保留着故事原来的次序。",
        "按下左右方向键，或点击页面下方的上一页、下一页，可以向前或向后阅读。目录中的每一项，都通向一个已经整理好的章节。",
        "书签并不只意味着“读到这里”。它也可以是一处想回来的风景，一个没想明白的问题，或一句舍不得立刻离开的文字。",
        "想寻找某个词语，可以打开左侧的搜索。搜索在本机完成，每一条结果都会带你回到相应的章节。",
        "好的阅读工具应该足够安静。工具退后一点，文字就能走近一点。",
    ]),
    ("属于你的书架", [
        "一个人的书架，常常是他走过的路。最初买下的书，后来反复读的书，还有那些迟迟没有打开的书，安静地站在一起。",
        "你可以用作者浏览书库，也可以搜索书名。最近阅读会留下故事的线索，尚未开始的图书则保留着下一次出发的可能。",
        "书籍只存储在你的电脑里。这个初版不需要账号，也不依赖云端服务。它把重的工作交给 C++，把文字与排版交给浏览器内核。",
        "窗口也有两种模样：系统提供的云母标题栏，以及用 Direct2D 绘制的标题栏。它们都围绕着同一个简单的目标：让你舒服地读下一页。",
        "愿你总能找到一本愿意打开的书，也愿你总能为自己留下一小段不被打扰的时间。",
    ]),
]


def main():
    target = ROOT / "resources" / "welcome.epub"
    target.parent.mkdir(parents=True, exist_ok=True)
    cover = '''<svg xmlns="http://www.w3.org/2000/svg" width="420" height="600" viewBox="0 0 420 600"><rect width="420" height="600" fill="#506044"/><rect x="18" width="3" height="600" fill="#b6bd9560"/><rect x="44" y="45" width="332" height="510" fill="none" stroke="#a7ae82" stroke-width="1"/><text x="210" y="110" text-anchor="middle" font-family="Georgia" font-size="12" letter-spacing="6" fill="#c8ccaf">THE QUIET HOURS</text><circle cx="210" cy="252" r="65" fill="none" stroke="#b7be97"/><path d="M162 273Q185 260 210 275Q235 260 258 273V218Q235 205 210 220Q185 205 162 218Z M210 220V275" fill="none" stroke="#c9cfab" stroke-width="2"/><text x="210" y="395" text-anchor="middle" font-family="Microsoft YaHei" font-size="32" letter-spacing="5" fill="#ecebd7">给阅读留一盏灯</text><text x="210" y="442" text-anchor="middle" font-family="Microsoft YaHei" font-size="13" letter-spacing="4" fill="#c5caab">DR Reader · 开始阅读</text><path d="M188 492h44" stroke="#b7be97"/><text x="210" y="526" text-anchor="middle" font-family="Georgia" font-size="10" letter-spacing="3" fill="#aeb897">A LITTLE SPACE TO READ</text></svg>'''
    with ZipFile(target, 'w') as z:
        z.writestr('mimetype', 'application/epub+zip', compress_type=ZIP_STORED)
        def put(name, text):
            z.writestr(name, text.encode('utf-8'), compress_type=ZIP_DEFLATED)
        put('META-INF/container.xml', '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
        items = ''.join(f'<item id="c{i}" href="chapter{i}.xhtml" media-type="application/xhtml+xml"/>' for i in range(len(CHAPTERS)))
        spine = ''.join(f'<itemref idref="c{i}"/>' for i in range(len(CHAPTERS)))
        put('OPS/package.opf', f'<package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/" unique-identifier="id" version="3.0"><metadata><dc:identifier id="id">urn:dr-reader:welcome:1</dc:identifier><dc:title>给阅读留一盏灯</dc:title><dc:creator>DR Reader</dc:creator><dc:language>zh-CN</dc:language><dc:publisher>DR Reader</dc:publisher><dc:subject>开始阅读</dc:subject><meta property="dcterms:modified">2026-10-21T00:00:00Z</meta></metadata><manifest>{items}<item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/><item id="cover" href="cover.svg" properties="cover-image" media-type="image/svg+xml"/></manifest><spine>{spine}</spine></package>')
        toc = ''.join(f'<li><a href="chapter{i}.xhtml">{escape(title)}</a></li>' for i, (title, _) in enumerate(CHAPTERS))
        put('OPS/nav.xhtml', f'<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body><nav epub:type="toc"><h1>目录</h1><ol>{toc}</ol></nav></body></html>')
        put('OPS/cover.svg', cover)
        for i, (title, paragraphs) in enumerate(CHAPTERS):
            body = ''.join(f'<p>{escape(text)}</p>' for text in paragraphs)
            put(f'OPS/chapter{i}.xhtml', f'<html xmlns="http://www.w3.org/1999/xhtml" lang="zh-CN"><head><meta charset="utf-8"/><title>{escape(title)}</title></head><body><h1 style="font-size:1.45em;font-weight:normal;margin-bottom:2em">{escape(title)}</h1>{body}</body></html>')
    print(target)


if __name__ == '__main__':
    main()
