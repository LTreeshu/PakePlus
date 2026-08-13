/*
 * ble-polyfill.js - navigator.bluetooth 原生桥接（基于官方 BleClient 封装）
 *
 * 适用场景：厂商 ROM 在系统层禁用了 WebView 的 Web Bluetooth（navigator.bluetooth 为
 * undefined）。本文件把 navigator.bluetooth 桥接到 @capacitor-community/bluetooth-le
 * 的官方 JS 封装 BleClient，网页代码无需改动。
 *
 * 前置：必须先加载 js/bluetooth-le.bundle.js（esbuild 打包的官方 BleClient，含
 * registerPlugin 代理，addListener 走 Capacitor callback 协议，通知事件才能正确分发；
 * 直接调原生代理 window.Capacitor.Plugins.BluetoothLe 的 addListener 收不到事件）。
 *
 * 用官方封装后：hex 转换、UUID 解析、通知事件(key 拼接)、断开回调全部由官方处理。
 */
(function () {
    'use strict';

    if (navigator.bluetooth) return;                       // 原生 Web Bluetooth 可用
    if (!(window.BLE && window.BLE.BleClient)) return;     // 需要 bundle 先加载(原生 App 内)

    var BleClient = window.BLE.BleClient;

    var initPromise = null;

    function ensureInit() {
        if (!initPromise) {
            initPromise = BleClient.initialize({ androidNeverForLocation: true }).catch(function (err) {
                console.error('[BLE-PF] init failed', err);
                initPromise = null;
                throw err;
            });
        }
        return initPromise;
    }

    function toDataView(v) {
        if (v instanceof DataView) return v;
        if (v instanceof ArrayBuffer) return new DataView(v);
        if (ArrayBuffer.isView(v)) return new DataView(v.buffer, v.byteOffset, v.byteLength);
        return v;
    }

    function bytesToHex(v) {
        if (!v) return '';
        var u8 = new Uint8Array(v.buffer || v, v.byteOffset || 0, v.byteLength || v.length);
        var arr = [];
        for (var i = 0; i < u8.length; i++) {
            var s = u8[i].toString(16);
            arr.push(s.length === 1 ? '0' + s : s);
        }
        return arr.join('');
    }

    var devicesById = new Map();
    var characteristicsById = new Map();

    function makeCharacteristic(deviceId, svc, c) {
        var key = deviceId + '|' + String(svc).toLowerCase() + '|' + String(c.uuid).toLowerCase();
        var existing = characteristicsById.get(key);
        if (existing) return existing;

        var ch = {
            uuid: c.uuid,
            _valueListeners: [],
            _notifyStarted: false,
            addEventListener: function (type, cb) {
                if (type === 'characteristicvaluechanged' && typeof cb === 'function') this._valueListeners.push(cb);
            },
            removeEventListener: function (type, cb) {
                var i = this._valueListeners.indexOf(cb);
                if (i >= 0) this._valueListeners.splice(i, 1);
            },
            writeValue: function (value) {
                var dv = toDataView(value);
                console.log('[BLE-PF] write', svc, c.uuid, bytesToHex(dv));
                return BleClient.write(deviceId, svc, c.uuid, dv);
            },
            readValue: function () {
                return BleClient.read(deviceId, svc, c.uuid);
            },
            startNotifications: function () {
                if (ch._notifyStarted) return Promise.resolve();
                ch._notifyStarted = true;
                return BleClient.startNotifications(deviceId, svc, c.uuid, function (value) {
                    console.log('[BLE-PF] notify rx:', bytesToHex(value), '| listeners:', ch._valueListeners.length);
                    // 标准 Web Bluetooth 语义: characteristicvaluechanged 事件里
                    // 数据在 event.target.value(即 characteristic.value) 上。
                    // 页面 onRxData 用 event.target.value.buffer 取字节,必须同步到 ch.value!
                    ch.value = value;
                    var dispatched = 0;
                    ch._valueListeners.forEach(function (cb) {
                        try { cb({ target: ch, value: value }); dispatched++; }
                        catch (err) { console.error('[BLE-PF] onRxData error:', err && err.message ? err.message : err); }
                    });
                    if (dispatched === 0) console.log('[BLE-PF] WARN: no characteristicvaluechanged listeners bound');
                });
            },
            stopNotifications: function () {
                return BleClient.stopNotifications(deviceId, svc, c.uuid);
            }
        };
        characteristicsById.set(key, ch);
        return ch;
    }

    function getServicesWithRetry(deviceId, attempt) {
        return BleClient.getServices(deviceId).then(function (r) {
            // 注意:官方 BleClient.getServices 直接返回数组(已解包 result.services),
            // 不是 { services: [...] } 对象;此处兼容两种形态。
            var list = Array.isArray(r) ? r : ((r && r.services) || []);
            if (list.length) return list;
            if (attempt >= 5) {
                // 兜底:仍为空才补一次显式服务发现
                console.log('[BLE-PF] services empty, fallback discoverServices attempt', attempt);
                return BleClient.discoverServices(deviceId)
                    .then(function () { return BleClient.getServices(deviceId); })
                    .then(function (r2) {
                        return Array.isArray(r2) ? r2 : ((r2 && r2.services) || []);
                    })
                    .catch(function (err) {
                        console.error('[BLE-PF] fallback discoverServices failed', err);
                        return list;
                    });
            }
            console.log('[BLE-PF] services empty, retry', attempt);
            return new Promise(function (res) { setTimeout(res, 300 * (attempt + 1)); })
                .then(function () { return getServicesWithRetry(deviceId, attempt + 1); });
        });
    }

    function makeDevice(bd) {
        var deviceId = bd.deviceId;
        var existing = devicesById.get(deviceId);
        if (existing) return existing;

        var device = {
            id: deviceId,
            name: bd.name || '',
            _disconnectListeners: [],
            gatt: null,
            addEventListener: function (type, cb) {
                if (type === 'gattserverdisconnected' && typeof cb === 'function') this._disconnectListeners.push(cb);
            },
            removeEventListener: function (type, cb) {
                var i = this._disconnectListeners.indexOf(cb);
                if (i >= 0) this._disconnectListeners.splice(i, 1);
            }
        };

        device.gatt = {
            connect: function () {
                return ensureInit().then(function () {
                    // 官方 connect 第二参数是设备断开回调(官方内部处理 disconnected 事件)
                    return BleClient.connect(deviceId, function () {
                        console.log('[BLE-PF] device disconnected:', deviceId);
                        device._disconnectListeners.forEach(function (cb) {
                            try { cb(); } catch (err) { console.error('[BLE-PF]', err); }
                        });
                    });
                }).then(function () {
                    // 关键:原生 onConnectionStateChange 里已自动 discoverServices,
                    // 不要再手动 discoverServices(会与自动发现竞态,部分设备导致服务表为空 NONE)。
                    // 直接用 getServices 取已发现的服务,空则带延时重试,最后才兜底补一次发现。
                    return getServicesWithRetry(deviceId, 0);
                }).then(function (result) {
                    return {
                        getPrimaryService: function (uuid) {
                            return BleClient.getServices(deviceId).then(function (result2) {
                                // 官方 getServices 返回数组(已解包);兼容两种形态
                                var list = Array.isArray(result2) ? result2 : ((result2 && result2.services) || []);
                                var su = String(uuid).toLowerCase();
                                var s = list.find(function (x) {
                                    return String(x.uuid).toLowerCase() === su;
                                });
                                if (!s) {
                                    // 诊断:列出设备实际发现的所有服务,方便确认设备类型/服务 UUID
                                    var uuids = list.map(function (x) { return String(x.uuid).toLowerCase(); });
                                    console.error('[BLE-PF] requested service not found:', su, '| device services:', JSON.stringify(uuids));
                                    throw new Error('Service not found: ' + uuid + ' (device services: ' + (uuids.join(', ') || 'NONE') + ')');
                                }
                                return {
                                    uuid: s.uuid,
                                    getCharacteristic: function (cuid) {
                                        var cu = String(cuid).toLowerCase();
                                        var c = s.characteristics.find(function (x) {
                                            return String(x.uuid).toLowerCase() === cu;
                                        });
                                        if (!c) throw new Error('Characteristic not found: ' + cuid);
                                        return makeCharacteristic(deviceId, s.uuid, c);
                                    }
                                };
                            });
                        },
                        disconnect: function () {
                            return BleClient.disconnect(deviceId);
                        }
                    };
                });
            }
        };

        devicesById.set(deviceId, device);
        return device;
    }

    var bluetooth = {
        requestDevice: function (opts) {
            return ensureInit().then(function () {
                var services = [];
                var filters = (opts && opts.filters) || [];
                for (var i = 0; i < filters.length; i++) {
                    if (filters[i] && filters[i].services) services = services.concat(filters[i].services);
                }
                if (opts && opts.optionalServices) services = services.concat(opts.optionalServices);
                services = services.filter(Boolean);
                var req = services.length ? { services: services } : undefined;
                return BleClient.requestDevice(req).then(makeDevice);
            });
        }
    };

    try {
        Object.defineProperty(navigator, 'bluetooth', { value: bluetooth, configurable: true, writable: true });
        window.__BLE_BRIDGE = true;
        console.log('[BLE-PF] native BLE bridge installed via BleClient (navigator.bluetooth)');
    } catch (err) {
        console.error('[BLE-PF] install failed', err);
    }
})();
