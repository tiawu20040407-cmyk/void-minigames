"""平台自动测试：启动一个临时平台（独立数据目录），用真实浏览器跑完整流程。

用法（在仓库根目录）：
    pip install playwright && python -m playwright install chromium
    python tools/test/platform_test.py            # 默认用 playwright 自带的 chromium
    CHROME=/usr/bin/google-chrome python tools/test/platform_test.py

覆盖：KP 初始化与登录、邀请码注册、审核、入口三种状态与即时推送、游戏文件访问控制
（含入口关闭后本局素材仍可加载）、场景预设、秘密消息与已读、预览视角、入口改名与自动发现、
系统状态、限流、退出后 404；第 3a 步仿生人 HUD：开机动画只播一次、搭档体征随 HP 变化且不泄露 HP 数字、
体征覆盖、扫描条目（隐藏的不发送、开放即时出现、“新”标记、改内容即时更新、环境台词、预设保存扫描状态）、
界面故障、型号与颜色、退回审核时切回普通终端、手机布局。截图存到 /tmp/void-shots/。
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

        hud_tests(kp, ph, phc, br, errs)

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
        pw = rows[2].split('\t')[1].strip()
        check(not re.search(r'[lo01i]', pw), '测试密码不含容易看错的字符')
        # 和 KP 在同一个浏览器里登录测试玩家：两边都不应被顶掉
        t2 = kpc.new_page(); t2.goto(B + '/'); t2.fill('#u', 'Test-HO2'); t2.fill('#p', ' ' + pw + ' \t'); t2.click('button[type=submit]')
        t2.wait_for_selector('text=测试机')
        check(True, '测试账号可以登录（账号名大小写、密码前后空格不影响）')
        check(t2.locator('#boot:not([hidden])').count() == 1, '新登录播放开机自检')
        t2.click('#boot'); t2.wait_for_selector('#boot', state='hidden')
        check(True, '点击跳过开机自检')
        kp.reload(); kp.wait_for_selector('#users .player')
        check(kp.url == B + '/kp', '同一浏览器登录玩家后 KP 仍在登录状态')
        kp.select_option('select[data-unlock][data-entry=hack]', 'open'); kp.wait_for_selector('select.s-open[data-entry=hack]')
        t2.reload(); t2.wait_for_selector('text=测试机')
        check(t2.url == B + '/hud', 'KP 操作后玩家页面仍在登录状态')
        t2.goto(B + '/'); t2.wait_for_selector('#cur:not([hidden])')
        check('测试机' in t2.inner_text('#cur'), '登录页显示当前玩家')
        t2.click('#switch'); t2.wait_for_selector('#f:not([hidden])')
        check(t2.locator('#kpnote').is_visible(), '切换账号：玩家退出，同一浏览器的 KP 仍在登录')
        t2.fill('#u', 'test-ho1'); t2.fill('#p', rows[1].split('\t')[1].strip()); t2.click('button[type=submit]')
        t2.wait_for_selector('text=测试员')
        check(t2.url == B + '/terminal', '换成人类测试账号后看到普通终端')
        t2.goto(B + '/hud'); t2.wait_for_url(B + '/terminal')
        check(True, '人类打开 /hud 自动转回 /terminal')
        t2.goto(B + '/'); t2.click('#switch'); t2.wait_for_selector('#f:not([hidden])')
        t2.fill('#u', 'test-ho2'); t2.fill('#p', pw); t2.click('button[type=submit]')
        t2.wait_for_url(B + '/hud'); t2.wait_for_selector('text=测试机')
        kp.once('dialog', lambda d: d.accept())
        card = kp.locator('.player', has_text='test-ho2')
        card.locator('[data-act=edit]').click(); card.locator('[data-act=delete]').click()
        t2.wait_for_url(B + '/', timeout=8000)
        check(True, '删除账号后对方页面退回登录页')
        kp.reload(); kp.wait_for_selector('#p-players')
        check(kp.url == B + '/kp', '玩家被删除后 KP 仍在登录状态')

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

def hud_tests(kp, ph, phc, br, errs):
    def kapi(path, body=None):
        return kp.evaluate('p => api(p)', path) if body is None else kp.evaluate('([p, b]) => api(p, b)', [path, body])
    def phapi(path):
        return ph.evaluate('p => api(p)', path)

    print('仿生人 HUD（3a）')
    pc = cookie_header(phc)
    req = urllib.request.Request(B + '/terminal'); req.add_header('Cookie', pc)
    check('仿生科终端' in urllib.request.urlopen(req).read().decode(), '/terminal 对谁都是同一个页面（不按身份换内容，缓存安全）')
    ph.goto(B + '/'); ph.wait_for_selector('#cur:not([hidden])')
    check('br800' in ph.inner_text('#cur') and ph.locator('#f[hidden]').count() == 1, '已登录玩家打开登录页：显示当前账号，不自动跳转')
    ph.click('#go'); ph.wait_for_selector('body.hud')
    check(ph.url == B + '/hud', '仿生人进入终端后转到 /hud')
    check(ph.locator('#boot:not([hidden])').count() == 0, '同一次登录内刷新不再播开机动画')
    check(ph.inner_text('#tier') == 'NO LINK', '搭档未注册时显示未连接')
    check(ph.inner_text('#model') == 'BR800', 'HO2 默认型号 BR800')
    # 注册搭档 HO1 并审核
    inv = kapi('/api/kp/invite', {'ho': 'HO1'})['code']
    r = urllib.request.Request(B + '/api/register', data=json.dumps({'code': inv, 'username': 'kuroda-jr', 'password': 'abcdef',
        'sheet': {'name': '新人刑警', 'dex': 70, 'hp': 12, 'comp': 30, 'hack': 0, 'spot': 60, 'mech': 0, 'lock': 0, 'idea': 70}}).encode(),
        headers={'X-Void': '1', 'Content-Type': 'application/json'})
    human = json.loads(urllib.request.urlopen(r).read())['user']['id']
    check(ph.inner_text('#tier') == 'NO LINK', '搭档待审核时仍显示未连接')
    kapi('/api/kp/user', {'id': human, 'status': 'approved'})
    ph.wait_for_function("document.querySelector('#pname').textContent.includes('新人刑警')", timeout=5000)
    check(ph.inner_text('#tier') == '无伤', '搭档审核后体征连上，满 HP 为无伤')
    hr = int(ph.inner_text('#v-hr'))
    check(60 <= hr <= 85, f'无伤心率在正常范围（{hr}）')
    h = phapi('/api/hud')
    check('hpNow' not in json.dumps(h) and 'hp' not in h['partner'], '玩家收到的数据里没有搭档的 HP 数字')

    print('体征面板')
    kp.reload(); kp.wait_for_selector(f'.vrow[data-vid="{human}"]')
    row = kp.locator(f'.vrow[data-vid="{human}"]')
    row.locator('[data-hpd="-5"]').click()
    ph.wait_for_function("document.querySelector('#tier').textContent === '轻伤'", timeout=5000)
    check(True, 'HP 12→7：搭档 HUD 一秒内变为轻伤')
    row = kp.locator(f'.vrow[data-vid="{human}"]')
    row.locator('[data-hpd="-1"]').click()
    kp.wait_for_function('([id, v]) => document.querySelector(`.vrow[data-vid="${id}"] .hp`).textContent === v', arg=[human, '6/12'], timeout=5000)
    check(ph.inner_text('#tier') == '轻伤', 'HP 6/12（正好一半）仍是轻伤')
    row = kp.locator(f'.vrow[data-vid="{human}"]')
    row.locator('[data-hpd="-1"]').click()
    ph.wait_for_function("document.querySelector('#tier').textContent === '重伤'", timeout=5000)
    check(True, 'HP 5/12（不足一半）：重伤')
    row = kp.locator(f'.vrow[data-vid="{human}"]')
    row.locator('[name=hpv]').fill('0'); row.locator('[data-hpset]').click()
    ph.wait_for_function("document.querySelector('#tier').textContent === '濒死'", timeout=5000)
    check(True, '设为 0：濒死')
    row = kp.locator(f'.vrow[data-vid="{human}"]')
    row.locator('[name=hpv]').fill('99'); row.locator('[data-hpset]').click()
    kp.wait_for_function('([id, v]) => document.querySelector(`.vrow[data-vid="${id}"] .hp`).textContent === v', arg=[human, '12/12'], timeout=5000)
    check(True, 'HP 不会超过上限')
    row = kp.locator(f'.vrow[data-vid="{human}"]')
    row.locator('[name=hpv]').fill('3'); row.locator('[data-hpset]').click()
    ph.wait_for_function("document.querySelector('#tier').textContent === '重伤'", timeout=5000)
    row = kp.locator(f'.vrow[data-vid="{human}"]')
    row.locator('[name=hr]').fill('130'); row.locator('[name=bp]').fill('140/90'); row.locator('[data-vov]').click()
    ph.wait_for_function("document.querySelector('#v-hr').textContent === '130'", timeout=5000)
    check('ov' in ph.get_attribute('#v-hr', 'class') and ph.inner_text('#v-bp') == '140/90', '手动覆盖心率、血压')
    row = kp.locator(f'.vrow[data-vid="{human}"]')
    row.locator('[name=bp]').fill('abc'); row.locator('[data-vov]').click()
    kp.wait_for_selector(f'.vrow[data-vid="{human}"] .msg.bad')
    check('120/80' in kp.inner_text(f'.vrow[data-vid="{human}"] .msg'), '血压格式错误时提示')
    kp.locator(f'.vrow[data-vid="{human}"] [data-vclr]').click()
    ph.wait_for_function("document.querySelector('#v-hr').textContent !== '130'", timeout=5000)
    check(110 <= int(ph.inner_text('#v-hr')) <= 130, '清除覆盖后按伤情自动')

    print('扫描条目')
    ph.click('#scanbtn'); ph.wait_for_selector('.ambient', timeout=5000)
    check(ph.locator('.ambient .p').inner_text().startswith('搭档 新人刑警：重伤'), '没有开放条目时显示搭档状态和环境描述')
    kp.fill('#snt', '黑色装甲仿生人（4 台）'); kp.fill('#snl', '制造编号：无法读取\n装甲：2'); kp.click('#snadd'); kp.wait_for_selector('#snm.good')
    kp.wait_for_selector('.scanitem')
    sid = kp.get_attribute('.scanitem', 'data-sc')
    h = phapi('/api/hud')
    check(h['scans'] == [] and '黑色装甲' not in json.dumps(h, ensure_ascii=False), '隐藏的扫描条目不发送到玩家浏览器')
    check(kp.locator(f'select[data-unlock="{human}"][data-entry="scan:{sid}"]').count() == 0, '人类玩家没有扫描开关')
    kp.select_option(f'select[data-unlock="2"][data-entry="scan:{sid}"]', 'open')
    ph.wait_for_selector('#newdata:not([hidden])', timeout=5000)
    check(True, '开放后 HUD 提示检测到新数据')
    check(ph.locator('.sitem').count() == 0, '没按扫描前不直接显示新条目')
    ph.click('#scanbtn'); ph.wait_for_selector('.sitem', timeout=5000)
    check(ph.locator('.sitem .new').count() == 1, '新条目标“新”')
    ph.click('.sitem .h')
    check('装甲：2' in ph.inner_text('.sitem .d') and ph.locator('.sitem .new').count() == 0, '点开看到数据，“新”消失')
    it = kp.locator(f'.scanitem[data-sc="{sid}"]')
    it.locator('[name=sl]').fill('制造编号：无法读取\n装甲：2\n弱点：关节'); it.locator('[data-scsave]').click()
    ph.wait_for_function("document.querySelector('.sitem .d').textContent.includes('弱点')", timeout=5000)
    check(True, '修改条目内容后玩家那边即时更新')
    ph.wait_for_timeout(3000); ph.locator('#b-vitals').screenshot(path=f'{SHOTS}/m_vitals.png')
    ph.screenshot(path=f'{SHOTS}/m_hud.png', full_page=True)
    sw = ph.evaluate('document.documentElement.scrollWidth')
    check(sw <= 380, f'手机宽度下没有横向溢出（{sw}px）')

    print('场景预设保存扫描状态')
    kp.fill('#pname', '扫描预设'); kp.click('#psave'); kp.wait_for_selector('#presets >> text=扫描预设')
    kp.select_option(f'select[data-unlock="2"][data-entry="scan:{sid}"]', 'hidden')
    ph.wait_for_function("!document.querySelector('.sitem')", timeout=5000)
    check(True, '隐藏后条目从玩家 HUD 消失')
    kp.once('dialog', lambda d: (check('扫描·黑色装甲' in d.message, '应用预设的确认框列出扫描条目'), d.accept()))
    kp.locator('#presets tr', has_text='扫描预设').locator('[data-papply]').click()
    ph.wait_for_selector('#newdata:not([hidden])', timeout=5000)
    check(len(phapi('/api/hud')['scans']) == 1, '应用预设后扫描条目恢复开放')

    print('环境台词、型号、界面故障')
    kp.fill('#amb', '测试台词甲'); kp.click('#ambsave'); kp.wait_for_selector('#ambm.good')
    kp.select_option(f'select[data-unlock="2"][data-entry="scan:{sid}"]', 'hidden')
    ph.wait_for_selector('#newdata[hidden]', state='attached', timeout=5000)
    ph.click('#scanbtn'); ph.wait_for_selector('.ambient', timeout=5000)
    check('测试台词甲' in ph.inner_text('.ambient'), '扫描显示 KP 编辑的环境台词')
    row = kp.locator('[data-mid2="2"]'); row.locator('[name=model]').fill('BR800-T'); row.locator('[data-msave]').click()
    ph.wait_for_function("document.querySelector('#model').textContent === 'BR800-T'", timeout=5000)
    check(True, '改型号后 HUD 即时更新')
    kp.select_option('#glu', '2'); kp.select_option('#gle', 'snow'); kp.fill('#glt', '警告：检测到外部入侵'); kp.click('#glgo')
    kp.wait_for_selector('#glm.good')
    ph.wait_for_selector('#snow:not([hidden])', timeout=3000)
    check('外部入侵' in ph.inner_text('#gtext'), '雪花错字带附加文字')
    ph.screenshot(path=f'{SHOTS}/m_glitch.png')
    ph.wait_for_selector('#snow', state='hidden', timeout=4000)
    check(ph.inner_text('#model') == 'BR800-T', '雪花结束后文字恢复')
    kp.select_option('#gle', 'black'); kp.fill('#glt', ''); kp.click('#glgo')
    ph.wait_for_selector('#black:not([hidden])', timeout=3000)
    ph.wait_for_selector('#black', state='hidden', timeout=5000)
    check(True, '黑屏 3 秒后恢复')

    print('HO4 旧型机外观（预览）')
    inv = kapi('/api/kp/invite', {'ho': 'HO4'})['code']
    r = urllib.request.Request(B + '/api/register', data=json.dumps({'code': inv, 'username': 'old-unit', 'password': 'abcdef',
        'sheet': {'name': '旧型机', 'dex': 50, 'hp': 24, 'comp': 50, 'hack': 70, 'spot': 50, 'mech': 30, 'lock': 30, 'idea': 40}}).encode(),
        headers={'X-Void': '1', 'Content-Type': 'application/json'})
    old = json.loads(urllib.request.urlopen(r).read())['user']['id']
    kapi('/api/kp/user', {'id': old, 'status': 'approved', 'hudColor': 'green', 'model': 'RK-02'})
    pv = kp.context.new_page(); pv.on('pageerror', lambda e: errs.append('pv4: ' + str(e)))
    pv.set_viewport_size({'width': 1280, 'height': 860})
    pv.goto(B + f'/terminal?as={old}'); pv.wait_for_selector('body.hud.c-green.old')
    check(pv.locator('#boot:not([hidden])').count() == 0 and pv.locator('.preview-bar').count() == 1, '预览旧型机：绿色、不播开机动画')
    check(pv.inner_text('#tier') == 'NO LINK', 'HO4 没有 HO3 搭档时显示未连接')
    pv.wait_for_timeout(600); pv.screenshot(path=f'{SHOTS}/hud_ho4_green.png')
    kapi('/api/kp/user', {'id': old, 'hudColor': 'amber'})
    pv.wait_for_selector('body.hud.c-amber', timeout=5000)
    check(True, '改颜色后预览即时更新')
    pv.goto(B + '/terminal?as=2'); pv.wait_for_selector('body.hud.c-cyan')
    pv.wait_for_timeout(600); pv.screenshot(path=f'{SHOTS}/hud_ho2.png', full_page=True)
    pv.close()

    print('退回审核时切回普通终端')
    kapi('/api/kp/user', {'id': 2, 'status': 'pending'})
    ph.wait_for_selector('text=等待 KP 审核', timeout=8000)
    check(ph.locator('body.hud').count() == 0, '退回后显示普通终端')
    kapi('/api/kp/user', {'id': 2, 'status': 'approved'})
    ph.wait_for_selector('body.hud', timeout=8000)
    check(ph.locator('#boot:not([hidden])').count() == 0, '再次审核通过回到 HUD，不重播开机动画')
    ph.wait_for_selector('.prog >> text=监控录像分析')

if __name__ == '__main__':
    main()
