"""平台自动测试：启动一个临时平台（独立数据目录），用真实浏览器跑完整流程。

用法（在仓库根目录）：
    pip install playwright && python -m playwright install chromium
    python tools/test/platform_test.py            # 默认用 playwright 自带的 chromium
    CHROME=/usr/bin/google-chrome python tools/test/platform_test.py

覆盖：KP 初始化与登录、邀请码注册、审核、入口三种状态与即时推送、游戏文件访问控制
（含入口关闭后本局素材仍可加载）、场景预设、秘密消息与已读、预览视角、入口改名与自动发现、
系统状态、限流、退出后 404。截图存到 /tmp/void-shots/。
"""
import json, os, re, shutil, subprocess, sys, tempfile, time, urllib.request
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PORT = int(os.environ.get('PORT', '3199'))
B = f'http://127.0.0.1:{PORT}'
SHOTS = '/tmp/void-shots'
TEMP_GAME = os.path.join(ROOT, 'games', 'zz-test-temp')

fails = []
def check(cond, what):
    print(('  ok  ' if cond else '  FAIL ') + what)
    if not cond: fails.append(what)

def status(url, cookies=None):
    req = urllib.request.Request(B + url)
    if cookies: req.add_header('Cookie', cookies)
    try:
        return urllib.request.urlopen(req).status
    except urllib.error.HTTPError as e:
        return e.code

def cookie_header(ctx):
    return '; '.join(f"{c['name']}={c['value']}" for c in ctx.cookies())

def main():
    os.makedirs(SHOTS, exist_ok=True)
    data = tempfile.mkdtemp(prefix='void-data-')
    env = dict(os.environ, PORT=str(PORT), VOID_DATA_DIR=data)
    srv = subprocess.Popen(['node', 'platform/server.js'], cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    log = ''
    try:
        t0 = time.time()
        while 'SETUP-' not in log or '平台已启动' not in log:
            log += srv.stdout.readline()
            if time.time() - t0 > 10: raise RuntimeError('平台没有启动：\n' + log)
        code = re.search(r'SETUP-[A-Z0-9-]+', log).group(0)
        run(code)
    finally:
        srv.terminate()
        shutil.rmtree(data, ignore_errors=True)
        shutil.rmtree(TEMP_GAME, ignore_errors=True)
    print('\n' + ('全部通过' if not fails else f'{len(fails)} 项失败：\n- ' + '\n- '.join(fails)))
    sys.exit(1 if fails else 0)

def run(code):
    errs = []
    with sync_playwright() as p:
        kw = {'executable_path': os.environ['CHROME']} if os.environ.get('CHROME') else {}
        br = p.chromium.launch(**kw)

        print('未登录访问')
        for u in ['/hack/', '/footage/', '/games/hack/', '/games/hack/index.html', '/games/footage/', '/games/hack/../../platform/data/db.json']:
            check(status(u) == 404, f'{u} 返回 404')

        print('KP 初始化与登录')
        kpc = br.new_context(viewport={'width': 1200, 'height': 900})
        kp = kpc.new_page(); kp.on('pageerror', lambda e: errs.append('kp: ' + str(e)))
        kp.goto(B + '/kp/setup')
        kp.fill('[name=code]', code.lower()); kp.fill('[name=password]', 'kppassword1'); kp.fill('[name=password2]', 'kppassword1'); kp.fill('[name=secret]', '秘密口令')
        kp.click('button[type=submit]'); kp.wait_for_selector('text=初始化完成')
        check(status('/kp/setup') == 404, '初始化后 /kp/setup 变成 404')
        kp.click('text=去登录')
        kp.fill('[name=username]', '咕咕'); kp.fill('[name=password]', 'kppassword1'); kp.fill('[name=secret]', '错误密令')
        kp.click('button[type=submit]'); kp.wait_for_selector('#m.bad')
        check('验证失败' in kp.inner_text('#m'), '密令错误时拒绝')
        kp.fill('[name=secret]', '秘密口令'); kp.click('button[type=submit]'); kp.wait_for_url(B + '/kp')
        kp.wait_for_selector('#sys b')
        check('MB' in kp.inner_text('#sys'), '系统状态显示')

        print('邀请码注册（手机）')
        kp.select_option('#ho', 'HO2'); kp.click('#gen'); kp.wait_for_selector('#im.good')
        inv = re.search(r'VOID-[A-Z0-9-]+', kp.inner_text('#im')).group(0)
        phc = br.new_context(viewport={'width': 375, 'height': 740}, is_mobile=True, has_touch=True)
        ph = phc.new_page(); ph.on('pageerror', lambda e: errs.append('ph: ' + str(e)))
        ph.goto(B + '/'); ph.click('text=新职员登记'); ph.wait_for_selector('[name=dex]')
        ph.fill('[name=code]', inv.lower()); ph.fill('[name=username]', 'br800'); ph.fill('[name=password]', 'abcdef'); ph.fill('[name=password2]', 'abcdef')
        ph.fill('[name=name]', 'BR800')
        for k, v in dict(dex=60, hp=13, comp=80, hack=0, spot=70, mech=40, lock=10, idea=50).items(): ph.fill(f'[name={k}]', str(v))
        ph.click('button[type=submit]'); ph.wait_for_url(B + '/terminal'); ph.wait_for_selector('text=等待 KP 审核')
        r = urllib.request.Request(B + '/api/register', data=json.dumps({'code': inv, 'username': 'again', 'password': '123456', 'sheet': {}}).encode(), headers={'X-Void': '1', 'Content-Type': 'application/json'})
        try: urllib.request.urlopen(r); reused = True
        except urllib.error.HTTPError: reused = False
        check(not reused, '邀请码不能重复使用')

        print('审核与即时推送')
        kp.wait_for_selector('.player .name:text("BR800")')
        kp.wait_for_selector('.player .dot.on')
        check(True, 'KP 看到玩家在线')
        kp.click('[data-act=approve]')
        ph.wait_for_selector('text=其他程序', timeout=5000)
        check(True, '审核通过后玩家页面自动刷新（未手动刷新）')
        sel = 'select[data-unlock][data-entry=footage]'
        kp.select_option(sel, 'open')
        ph.wait_for_selector('text=监控录像分析', timeout=5000)
        check(True, '开放入口后玩家页面一秒内出现')
        kp.wait_for_selector('select.s-open[data-entry=footage]')
        kp.select_option('select[data-unlock][data-entry=hack]', 'locked')
        ph.wait_for_selector('.prog.locked >> text=骇入程序', timeout=5000)
        ph.click('.prog.locked >> text=骇入程序')
        check('权限不足' in ph.inner_text('#lm'), '锁定入口显示名字，点击提示权限不足')
        check(ph.locator('a:text("启动")').count() == 1, '锁定入口没有启动按钮')
        ph.screenshot(path=f'{SHOTS}/m_terminal.png', full_page=True)

        print('游戏文件访问控制')
        pc = cookie_header(phc)
        check(status('/games/hack/', pc) == 404, '锁定的游戏页面 404')
        check(status('/games/footage/', pc) == 200, '开放的游戏页面 200')
        with ph.expect_popup() as pop: ph.click('a:text("启动")')
        g = pop.value; g.wait_for_load_state()
        check('录像排序' in g.title(), '从终端启动游戏')
        g.close()
        # 开放 hack，打开一次页面，再关闭：页面 404，素材仍能加载（本局打完）
        kp.select_option('select[data-unlock][data-entry=hack]', 'open'); kp.wait_for_selector('select.s-open[data-entry=hack]')
        audio = sorted(os.listdir(os.path.join(ROOT, 'games', 'hack', 'audio')))[0]
        check(status('/games/hack/', pc) == 200, 'hack 开放后可打开')
        kp.select_option('select[data-unlock][data-entry=hack]', 'hidden'); kp.wait_for_selector('select.s-hidden[data-entry=hack]')
        check(status('/games/hack/', pc) == 404, '关闭后 hack 页面 404')
        check(status(f'/games/hack/audio/{audio}', pc) == 200, '关闭后已打开的这一局仍能加载音频')
        check(status(f'/games/hack/audio/{audio}') == 404, '未登录加载音频 404')

        print('场景预设')
        kp.fill('#pname', '测试预设A'); kp.click('#psave'); kp.wait_for_selector('#presets >> text=测试预设A')
        kp.select_option('select[data-unlock][data-entry=footage]', 'hidden'); kp.wait_for_selector('select.s-hidden[data-entry=footage]')
        ph.wait_for_function("!document.body.innerText.includes('监控录像分析')", timeout=5000)
        check(True, '关闭入口后玩家页面里消失')
        kp.once('dialog', lambda d: d.accept())
        kp.click('[data-papply]')
        ph.wait_for_selector('text=监控录像分析', timeout=5000)
        check(True, '应用预设后玩家页面恢复')

        print('秘密消息')
        kp.check('#rcpt input[value="2"]'); kp.fill('#mtitle', '秘密情报'); kp.fill('#mbody', '你可以远程黑进简单的机械里。\n第二行。')
        kp.click('#msend'); kp.wait_for_selector('#mm.good')
        ph.wait_for_selector('.modal >> text=秘密情报', timeout=5000)
        check('第二行' in ph.inner_text('.modal'), '玩家收到弹窗，正文完整')
        ph.screenshot(path=f'{SHOTS}/m_message.png')
        kp.wait_for_selector('#sent .tag.warn')
        check('未读' in kp.inner_text('#sent'), 'KP 看到未读')
        ph.click('#ack')
        kp.wait_for_selector('#sent .tag.good', timeout=5000)
        check('已读' in kp.inner_text('#sent'), 'KP 看到已读')
        check(ph.locator('.msgitem').count() == 1, '消息出现在玩家消息列表')

        print('离线消息')
        kp.check('#rcpt input[value="2"]'); kp.fill('#mtitle', '离线时发的'); kp.fill('#mbody', '下次登录再看')
        ph.close()
        kp.click('#msend'); kp.wait_for_selector('#mm.good')
        ph = phc.new_page(); ph.on('pageerror', lambda e: errs.append('ph: ' + str(e)))
        ph.goto(B + '/terminal'); ph.wait_for_selector('.modal >> text=离线时发的', timeout=5000)
        check(True, '离线消息在下次打开时弹出')
        ph.click('#ack')

        print('预览视角')
        with kp.expect_popup() as pop: kp.click('.player >> text=预览视角')
        pv = pop.value; pv.on('pageerror', lambda e: errs.append('pv: ' + str(e)))
        pv.wait_for_selector('.preview-bar')
        check('br800' in pv.inner_text('.preview-bar'), '预览横幅显示玩家')
        check(pv.locator('.modal').count() == 0, '预览不弹消息、不标记已读')
        check(pv.locator('a:text("启动")').count() == 0, '预览中不能启动游戏')
        kp.select_option('select[data-unlock][data-entry=hack]', 'open')
        pv.wait_for_selector('text=骇入程序', timeout=5000)
        check(True, '预览页面跟着实时更新')
        pv.screenshot(path=f'{SHOTS}/preview.png', full_page=True)
        pv.close()

        print('入口改名与自动发现')
        row = kp.locator('.entry-row[data-eid=footage]')
        row.locator('[name=ename]').fill('监控录像 · 改名测试')
        row.locator('[name=edesc]').fill('说明文字')
        row.locator('button:text("保存")').click()
        ph.wait_for_selector('text=改名测试', timeout=5000)
        check('说明文字' in ph.inner_text('#main'), '改名和说明推送到玩家')
        os.makedirs(TEMP_GAME, exist_ok=True)
        open(os.path.join(TEMP_GAME, 'index.html'), 'w').write('<title>temp</title>')
        kp.reload(); kp.wait_for_selector('.entry-row[data-eid=zz-test-temp]')
        check(kp.locator('.entry-row[data-eid=zz-test-temp] [name=ename]').input_value() == '未命名程序', '新游戏自动出现，默认叫未命名程序')
        check(status('/games/zz-test-temp/', cookie_header(phc)) == 404, '新游戏默认对玩家隐藏')
        kp.screenshot(path=f'{SHOTS}/kp.png', full_page=True)

        print('表单不被推送覆盖')
        kp.fill('#mtitle', '写到一半')
        kp.select_option('select[data-unlock][data-entry=hack]', 'locked'); kp.wait_for_selector('select.s-locked[data-entry=hack]')
        check(kp.input_value('#mtitle') == '写到一半', '刷新后正在写的消息还在')

        print('测试账号与删除')
        kp.click('#test'); kp.wait_for_selector('#testout td')
        rows = kp.locator('#testout tr').all_inner_texts()
        pw = rows[2].split('\t')[1]
        t2 = br.new_context().new_page(); t2.goto(B + '/'); t2.fill('#u', 'test-ho2'); t2.fill('#p', pw); t2.click('button[type=submit]')
        t2.wait_for_selector('text=测试机')
        check(True, '测试账号可以登录')
        kp.once('dialog', lambda d: d.accept())
        card = kp.locator('.player', has_text='test-ho2')
        card.locator('[data-act=edit]').click(); card.locator('[data-act=delete]').click()
        t2.wait_for_url(B + '/', timeout=8000)
        check(True, '删除账号后对方页面退回登录页')

        print('退出与限流')
        ph.click('#out'); ph.wait_for_url(B + '/')
        check(status('/games/footage/', cookie_header(phc)) == 404, '退出后游戏 404')
        codes = []
        for _ in range(6):
            r = urllib.request.Request(B + '/api/login', data=json.dumps({'username': 'br800', 'password': 'wrong'}).encode(), headers={'X-Void': '1', 'Content-Type': 'application/json'})
            try: urllib.request.urlopen(r)
            except urllib.error.HTTPError as e: codes.append(e.code)
        check(codes[-1] == 429, '连续输错后限流')

        br.close()
    check(not errs, '页面没有 JS 报错' + (('：' + '; '.join(errs)) if errs else ''))

if __name__ == '__main__':
    main()
