// ==UserScript==
// @name         VPS Create 自动化（常驻面板 + 数据中心控制 + 简化算术符号）
// @namespace    https://github.com/yourname/tampermonkey-scripts
// @version      2.7.0
// @description  常驻面板，支持密码、系统索引、数据中心空时刷新延迟、目标数据中心选择、缓存、开始/暂停；woiden 使用原始 nextSibling 方式获取运算符并计算验证码；自动提交 Cloudflare Turnstile 表单。
// @author       YourName
// @match        *://hax.co.id/create-vps/*
// @match        *://woiden.id/create-vps/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(() => {
    'use strict';

    /* ==========================================================
       1️⃣ 常量 & 全局变量
       ========================================================== */
    const PANEL_ID    = 'vps-auto-settings-panel';
    const STORAGE_KEY = 'vps_auto_settings';   // 本地缓存
    const STATE_KEY   = 'vps_auto_state';      // “running” / “paused”

    let automationRunning = false; // true → 正在运行，false → 已暂停
    let cfWatcherTimer    = null; // Cloudflare Turnstile 轮询计时器
    let dcRefreshTimer    = null; // 数据中心为空时的单次刷新计时器

    /* ==========================================================
       2️⃣ 工具函数
       ========================================================== */
    const waitForElement = (selector, callback) => {
        const el = document.querySelector(selector);
        if (el) return callback(el);
        setTimeout(() => waitForElement(selector, callback), 100);
    };

    // 你提供的 extractNumber（只取 “-” 之后、遇到 . 或 : 前的首位数字）
    const extractNumber = url => {
        const dashPos = url.indexOf("-");
        if (dashPos === -1) return 0;
        const separatorPos = url.slice(dashPos + 1).search(/[.:]/);
        if (separatorPos === -1) return 0;
        const numStr = url.slice(dashPos + 1, dashPos + 1 + separatorPos);
        const fullNumber = parseInt(numStr, 10) || 0;
        return fullNumber === 0 ? 0 : Number(String(fullNumber)[0]);
    };

    /* ==========================================================
       3️⃣ 常驻设置面板（密码、系统索引、刷新延迟、目标数据中心、缓存、开始/暂停）
       ========================================================== */
    function createPanel() {
        if (document.getElementById(PANEL_ID)) return; // 已经创建

        const isHax = location.host.includes('hax.co.id');

        const panel = document.createElement('div');
        panel.id = PANEL_ID;
        panel.style.position = 'fixed';
        panel.style.top = '12px';
        panel.style.right = '12px';
        panel.style.zIndex = 2147483647;
        panel.style.background = '#fff';
        panel.style.border = '2px solid #4a90e2';
        panel.style.borderRadius = '6px';
        panel.style.boxShadow = '0 2px 12px rgba(0,0,0,.15)';
        panel.style.padding = '12px';
        panel.style.fontFamily = 'Arial,Helvetica,sans-serif';
        panel.style.fontSize = '14px';
        panel.style.maxWidth = '300px';
        panel.style.minWidth = '210px';
        panel.style.color = '#333';

        // 只在 hax 页面出现目标数据中心下拉框
        const dcSelectHTML = isHax ? `
            <label>目标数据中心（可选）：
                <select id="vps-dc-choice" style="width:100%;margin-top:4px;">
                    <option value="">--- 默认（最后一个） ---</option>
                    <option value="US-OpenVZ-3">US-OpenVZ-3</option>
                    <option value="US-OpenVZ-2">US-OpenVZ-2</option>
                    <option value="EU-1">EU-1</option>
                </select>
            </label>
            <br/><br/>
        ` : '';

        panel.innerHTML = `
            <strong style="display:block;margin-bottom:8px;color:#4a90e2;">
                VPS 自动化（常驻）
            </strong>

            <label>密码：
                <input type="text" id="vps-pwd" style="width:100%;margin-top:4px;" placeholder="123"/>
            </label>
            <br/><br/>

            <label>系统索引 (0 起始)：
                <input type="number" id="vps-os-index" style="width:100%;margin-top:4px;" min="0"/>
            </label>
            <br/><br/>

            <label>数据中心为空时刷新延迟（ms）：
                <input type="number" id="vps-dc-delay" style="width:100%;margin-top:4px;" min="0"/>
            </label>
            <br/><br/>

            ${dcSelectHTML}

            <label>
                <input type="checkbox" id="vps-cache-toggle"/> 缓存设置
            </label>
            <br/><br/>

            <button id="vps-start-pause-btn"
                    style="width:100%;background:#4a90e2;color:#fff;border:none;padding:6px;cursor:pointer;">
                开始自动化
            </button>

            <small style="display:block;margin-top:6px;color:#777;">
                勾选“缓存设置”后，下次打开页面会自动填入上次保存的值。
            </small>
        `;

        // 挂到页面
        const attach = () => {
            document.body.appendChild(panel);
            loadPanelValues();   // 读取缓存、恢复运行状态
            bindPanelEvents();   // 绑定按钮、输入框等交互
        };
        if (document.body) attach();
        else waitForElement('body', attach);
    }

    // 读取缓存 + 恢复运行状态
    function loadPanelValues() {
        const saved = localStorage.getItem(STORAGE_KEY);
        const useCache = saved && JSON.parse(saved).cacheEnabled;
        document.getElementById('vps-cache-toggle').checked = !!useCache;

        if (useCache) {
            const { password, osIndex, dcDelay, dcChoice } = JSON.parse(saved);
            document.getElementById('vps-pwd').value      = password ?? '123';
            document.getElementById('vps-os-index').value = osIndex ?? 2;
            document.getElementById('vps-dc-delay').value = dcDelay ?? 5000;
            const sel = document.getElementById('vps-dc-choice');
            if (sel) sel.value = dcChoice ?? '';
        } else {
            document.getElementById('vps-pwd').value      = '123';
            document.getElementById('vps-os-index').value = 2;
            document.getElementById('vps-dc-delay').value = 5000;
        }

        // 读取上一次的运行状态（如果是“运行中”则直接启动）
        if (localStorage.getItem(STATE_KEY) === 'running') {
            automationRunning = true;
            document.getElementById('vps-start-pause-btn').textContent = '暂停';
            startAllProcesses();
        }
    }

    // 将面板当前值保存到本地缓存（仅在缓存勾选时使用）
    function saveSettingsToCache() {
        const data = {
            password: document.getElementById('vps-pwd').value.trim() || '123',
            osIndex: parseInt(document.getElementById('vps-os-index').value, 10) || 2,
            dcDelay: parseInt(document.getElementById('vps-dc-delay').value, 10) || 5000,
            dcChoice: (document.getElementById('vps-dc-choice') || {}).value || '',
            cacheEnabled: document.getElementById('vps-cache-toggle').checked
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    }

    // 绑定按钮、输入框等事件
    function bindPanelEvents() {
        const startBtn = document.getElementById('vps-start-pause-btn');

        startBtn.addEventListener('click', () => {
            automationRunning = !automationRunning;
            startBtn.textContent = automationRunning ? '暂停' : '开始自动化';
            localStorage.setItem(STATE_KEY, automationRunning ? 'running' : 'paused');

            if (automationRunning) {
                if (document.getElementById('vps-cache-toggle').checked) saveSettingsToCache();
                startAllProcesses();
            } else {
                stopAllProcesses();
            }
        });

        // 缓存开关改变时立即保存一次（若已勾选）
        document.getElementById('vps-cache-toggle').addEventListener('change', ev => {
            if (ev.target.checked) saveSettingsToCache();
        });

        // 所有输入框失去焦点后若已勾选缓存则同步保存
        ['vps-pwd', 'vps-os-index', 'vps-dc-delay', 'vps-dc-choice'].forEach(id => {
            const el = document.getElementById(id);
            if (!el) return;
            el.addEventListener('blur', () => {
                if (document.getElementById('vps-cache-toggle').checked) saveSettingsToCache();
            });
        });
    }

    /* ==========================================================
       4️⃣ 基础表单填充（密码、系统、用途、协议）
       ========================================================== */
    function fillBasicForm({ password, osIndex }) {
        // 隐藏可能出现的 <ins> 广告容器
        try {
            const ins = document.getElementsByTagName('ins');
            for (let i = 0; i < ins.length; i++) ins[i].style.display = 'none';
        } catch (e) {
            console.warn('[VPS‑Auto] 隐藏 <ins> 失败', e);
        }

        // 系统
        waitForElement('#os', el => {
            el.selectedIndex = osIndex;
            console.log(`[VPS‑Auto] 已设置系统索引 = ${osIndex}`);
        });

        // 密码
        waitForElement('#password', el => {
            el.value = password;
            console.log(`[VPS‑Auto] 已填写密码 = ${password}`);
        });

        // 用途（保持默认 index = 5）
        waitForElement('#purpose', el => (el.selectedIndex = 5));

        // 协议
        waitForElement('input[name="agreement[]"]', () => {
            const checks = document.getElementsByName('agreement[]');
            for (let i = 0; i < checks.length; i++) checks[i].checked = true;
            console.log('[VPS‑Auto] 已勾选所有协议复选框');
        });
    }

    /* ==========================================================
       5️⃣ 数据中心处理
       ========================================================== */
    function handleDatacenter({ dcDelay, dcChoice, isHax }) {
        waitForElement('#datacenter', selectEl => {
            // 数据中心列表仅有占位项 → 按设定延迟刷新页面
            if (selectEl.options.length === 1) {
                const delay = Number.isFinite(dcDelay) && dcDelay > 0 ? dcDelay : 5000; // 默认 5 秒
                console.warn(`[VPS‑Auto] 数据中心列表为空，将在 ${delay}ms 后刷新`);
                dcRefreshTimer = setTimeout(() => location.reload(), delay);
                return;
            }

            // 列表不为空 → 根据站点选择索引
            if (isHax && dcChoice) {
                // 在 hax 页面查找用户在下拉框里选的文字
                let foundIdx = -1;
                for (let i = 0; i < selectEl.options.length; i++) {
                    if (selectEl.options[i].textContent.trim() === dcChoice) {
                        foundIdx = i;
                        break;
                    }
                }
                if (foundIdx !== -1) {
                    selectEl.selectedIndex = foundIdx;
                    console.log(`[VPS‑Auto] 已根据用户选的文字 "${dcChoice}" 设置数据中心索引 (${foundIdx})`);
                } else {
                    // 未匹配 → 仍使用最后一个
                    selectEl.selectedIndex = selectEl.options.length - 1;
                    console.log('[VPS‑Auto] 未匹配到用户指定的文字，使用最后一个数据中心');
                }
            } else {
                // woiden 或者用户未指定 → 直接选最后一个
                selectEl.selectedIndex = selectEl.options.length - 1;
                console.log('[VPS‑Auto] 已选最后一个数据中心（默认）');
            }
        });
    }

    /* ==========================================================
       6️⃣ woiden 的算术验证码（使用原始 nextSibling 方式获取运算符）
       ========================================================== */
    function calculateAndFill() {
        const images = document.querySelectorAll('.col-sm-3 img');
        if (images.length !== 2) {
            console.warn('[VPS‑Auto] 未检测到算术图片，跳过验证码填充');
            return;
        }

        const num1 = extractNumber(images[0].src);
        const num2 = extractNumber(images[1].src);

        // **这里恢复为你原来的写法**（直接取 nextSibling 的文字）
        const operator = images[0].nextSibling.textContent.trim();

        let result = 0;
        switch (operator) {
            case '+': result = num1 + num2; break;
            case '-': result = num1 - num2; break;
            case '×':
            case '*':
            case 'x':
            case 'X': result = num1 * num2; break;
            case '÷':
            case '/': result = num1 / num2; break;
            default:
                console.warn(`[VPS‑Auto] 未识别运算符 "${operator}"，默认返回 0`);
                result = 0;
        }

        console.log(`运算结果: ${num1} ${operator} ${num2} = ${result}`);

        // 填写验证码输入框
        waitForElement('#captcha', input => {
            input.value = result;
            ['input', 'change', 'keyup'].forEach(ev => {
                input.dispatchEvent(new Event(ev, { bubbles: true }));
            });
            console.log(`[VPS‑Auto] 已自动填写验证码 = ${result}`);
        });
    }

    /* ==========================================================
       7️⃣ Cloudflare Turnstile 轮询 & 表单提交
       ========================================================== */
    function startCfWatcher() {
        const poll = 100; // ms
        const maxWait = 2 * 60 * 1000; // 2 分钟
        const start = Date.now();

        cfWatcherTimer = setInterval(() => {
            const cfInput = document.querySelector('input[name="cf-turnstile-response"]');
            const token = cfInput ? cfInput.value.trim() : '';
            if (token) {
                console.log('✅ CF Turnstile 已通过，Token:', token);
                clearInterval(cfWatcherTimer);
                cfWatcherTimer = null;

                // 提交按钮（原 XPath）
                const xpath = "/html/body/main/div/div/div[2]/div/div/div/div/div/form/button";
                const res = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                const btn = res.singleNodeValue;
                if (btn) {
                    console.log('[VPS‑Auto] 点击提交按钮...');
                    btn.click();
                } else {
                    console.warn('[VPS‑Auto] 未找到提交按钮，尝试通用 selector');
                    const alt = document.querySelector('form button[type="submit"], form button');
                    if (alt) {
                        console.log('[VPS‑Auto] 使用备用按钮提交');
                        alt.click();
                    } else {
                        console.error('[VPS‑Auto] 找不到任何提交按钮');
                    }
                }
            } else if (Date.now() - start > maxWait) {
                clearInterval(cfWatcherTimer);
                cfWatcherTimer = null;
                console.error('[VPS‑Auto] 等待 CF token 超时，自动化终止');
            } else {
                console.log('⏳ 正在等待 CF Turnstile 完成...');
            }
        }, poll);
    }

    /* ==========================================================
       8️⃣ 主流程：开始 / 停止
       ========================================================== */
    function startAllProcesses() {
        const isHax    = location.host.includes('hax.co.id');
        const isWoiden = location.host.includes('woiden.id');

        // 读取面板当前值（即使在运行期间用户随时改动也会被读取）
        const password    = document.getElementById('vps-pwd').value.trim() || '123';
        const osIndex     = parseInt(document.getElementById('vps-os-index').value, 10) || 2;
        const dcDelay     = parseInt(document.getElementById('vps-dc-delay').value, 10) || 5000;
        const dcChoice    = (document.getElementById('vps-dc-choice') || {}).value || '';

        console.log('[VPS‑Auto] 开始自动化 → 参数', {
            password, osIndex, dcDelay, dcChoice, isHax, isWoiden
        });

        // 1️⃣ 填充基础表单（除数据中心外的所有字段）
        fillBasicForm({ password, osIndex });

        // 2️⃣ 数据中心处理（空列表时延迟刷新，否则根据用户指定的文字定位）
        handleDatacenter({ dcDelay, dcChoice, isHax });

        // 3️⃣ woiden 的算术验证码（如果是 woiden）
        if (isWoiden) {
            calculateAndFill();
        }

        // 4️⃣ 启动 Cloudflare Turnstile 轮询（两站点均需要）
        startCfWatcher();
    }

    function stopAllProcesses() {
        if (cfWatcherTimer) {
            clearInterval(cfWatcherTimer);
            cfWatcherTimer = null;
            console.log('[VPS‑Auto] 已停止 CF Turnstile 轮询');
        }
        if (dcRefreshTimer) {
            clearTimeout(dcRefreshTimer);
            dcRefreshTimer = null;
            console.log('[VPS‑Auto] 已取消数据中心空刷新计时器');
        }
        console.log('[VPS‑Auto] 自动化已暂停');
    }

    /* ==========================================================
       9️⃣ 脚本入口
       ========================================================== */
    createPanel(); // 页面加载完毕后立刻创建面板
})();
