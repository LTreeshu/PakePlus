/*
 * pf-debug.js - 页面内 BLE 桥接调试浮层(仅调试用,定位"收不到数据"断点)
 *
 * 包装 console.log/error,把 [BLE-PF] 前缀的日志实时显示在页面左下角,
 * 无需 chrome://inspect/adb 即可看到:write 是否发出、notify 是否收到。
 * 必须在 ble-polyfill.js 之前加载。
 */
(function () {
    'use strict';
    if (document.getElementById('pfdebug')) return;

    var div = document.createElement('div');
    div.id = 'pfdebug';
    div.style.cssText = 'position:fixed;bottom:4px;left:4px;z-index:99999;' +
        'background:rgba(0,0,0,.8);color:#0f0;font:10px/1.4 monospace;' +
        'padding:6px;border-radius:4px;max-width:74%;max-height:140px;' +
        'overflow:auto;pointer-events:none;white-space:pre-wrap;word-break:break-all;';
    document.body.appendChild(div);

    var lines = [];
    function show(msg) {
        lines.push(msg);
        if (lines.length > 8) lines.shift();
        div.textContent = lines.join('\n');
    }

    function toStr(a) {
        if (typeof a === 'string') return a;
        if (a instanceof Error) return a.message || String(a);
        try { return JSON.stringify(a); } catch (e) { return String(a); }
    }

    var origLog = console.log.bind(console);
    var origErr = console.error.bind(console);
    console.log = function () {
        var s = Array.prototype.map.call(arguments, toStr).join(' ');
        if (s.indexOf('[BLE-PF]') >= 0) show(s);
        origLog.apply(null, arguments);
    };
    console.error = function () {
        var s = Array.prototype.map.call(arguments, toStr).join(' ');
        if (s.indexOf('[BLE-PF]') >= 0) show('ERR: ' + s);
        origErr.apply(null, arguments);
    };
})();
