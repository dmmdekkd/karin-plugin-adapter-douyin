import { dir } from "./dir.js";
import { createRequire } from "node:module";
import path, { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AdapterBase, contactFriend, contactGroup, copyConfigSync, createFriendDecreaseNotice, createFriendIncreaseNotice, createFriendMessage, createGroupAdminChangedNotice, createGroupApplyRequest, createGroupMemberAddNotice, createGroupMemberDelNotice, createGroupMessage, createGroupMessageReactionNotice, createGroupRecallNotice, createPrivateApplyRequest, createPrivateRecallNotice, filesByExt, logger, registerBot, requireFileSync, segment, senderFriend, senderGroup, unregisterBot, watch } from "node-karin";
import fs, { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import protobuf from "protobufjs";
import WebSocket from "ws";
import axios from "node-karin/axios";

//#region src/core/http/cookie.ts
/**
* 精简 CookieJar：不区分 domain/path，整站共享一份键值对。
* 语义与参考实现 douyin-im http/cookie-jar.ts 等价。
*/
var CookieJar = class {
	store = new Map();
	constructor(initial) {
		if (initial) this.merge(initial);
	}
	get(name) {
		return this.store.get(name);
	}
	has(name) {
		return this.store.has(name);
	}
	set(name, value) {
		this.store.set(name, value);
	}
	delete(name) {
		this.store.delete(name);
	}
	/** 导入 Cookie 请求头格式；响应 Set-Cookie 用 mergeSetCookie 以支持删除 */
	merge(raw) {
		const parts = raw.split(/[;\n]/).map((p) => p.trim()).filter(Boolean);
		for (const part of parts) {
			const eq = part.indexOf("=");
			if (eq <= 0) continue;
			const name = part.slice(0, eq).trim();
			const value = part.slice(eq + 1).trim();
			if (!name || name.toLowerCase() === "path" || name.toLowerCase() === "domain" || name.toLowerCase() === "expires" || name.toLowerCase() === "max-age" || name.toLowerCase() === "secure" || name.toLowerCase() === "httponly" || name.toLowerCase() === "samesite") {
				continue;
			}
			this.store.set(name, value);
		}
	}
	toHeader() {
		return [...this.store.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
	}
	/** 接受独立或合并的 Set-Cookie 字段（容忍 Expires 中的逗号），max-age<=0 或已过期则删除 */
	mergeSetCookie(raw, now = Date.now()) {
		for (const line of raw.split(/,(?=\s*[^\s;,=]+\s*=)/)) {
			const [pair, ...attributes] = line.split(";");
			const eq = pair?.indexOf("=") ?? -1;
			if (!pair || eq <= 0) continue;
			const name = pair.slice(0, eq).trim();
			const value = pair.slice(eq + 1).trim();
			let maxAge;
			let expires;
			for (const attribute of attributes) {
				const separator = attribute.indexOf("=");
				if (separator < 0) continue;
				const key = attribute.slice(0, separator).trim().toLowerCase();
				const val = attribute.slice(separator + 1).trim();
				if (key === "max-age" && /^-?\d+$/.test(val)) maxAge = Number(val);
				if (key === "expires") expires = Date.parse(val);
			}
			const deleted = maxAge !== undefined ? maxAge <= 0 : expires !== undefined && expires <= now;
			if (deleted) this.store.delete(name);
			else this.store.set(name, value);
		}
	}
};

//#endregion
//#region src/core/http/response.ts
/** 仅携带诊断元数据，不包含请求 query、凭据与响应体 */
var DouyinResponseError = class extends Error {
	kind;
	status;
	name = "DouyinResponseError";
	endpoint;
	logId;
	constructor(kind, status, url, headers) {
		const endpoint = new URL(url).pathname;
		const logId = headers.get("x-tt-logid") ?? undefined;
		super(`Douyin ${kind}: HTTP ${status} ${endpoint}${logId ? ` (logid=${logId})` : ""}`);
		this.kind = kind;
		this.status = status;
		this.endpoint = endpoint;
		this.logId = logId;
	}
};
/** 仅用于 JSON 接口；HTML/protobuf 响应由调用方自行解码 */
function parseJsonResponse(response, url) {
	const { status, headers, rawText, ok } = response;
	const fail = (kind) => {
		throw new DouyinResponseError(kind, status, url, headers);
	};
	let decoded;
	try {
		decoded = JSON.parse(rawText);
	} catch {
		if (headers.get("x-vc-bdturing-parameters")) return fail("captcha");
		if (headers.get("x-tt-verify-passport-decision")) return fail("passport-verification");
		if (/__ac_nonce|_\$jsvmprt/.test(rawText)) return fail("challenge");
		if (!ok) return fail("http");
		return fail(rawText.trim() ? "invalid-json" : "empty");
	}
	if (!ok) return fail("http");
	if (decoded === null || typeof decoded !== "object") return fail("invalid-json");
	return decoded;
}

//#endregion
//#region src/core/sign/constants.ts
/** 创作者平台公共常量（源自参考项目 creator/constants.ts 与 passport/signQs.ts） */
const CREATOR_ORIGIN = "https://creator.douyin.com";
const CREATOR_AID = "2906";
const PASSPORT_JSSDK_VERSION = "2.4.3";
/** 创作者 Passport 基础查询串 SDK 元信息（request_host 为预编码值） */
const PASSPORT_SDK_META = {
	passport_jssdk_version: PASSPORT_JSSDK_VERSION,
	passport_jssdk_type: "normal",
	is_from_ttaccountsdk: "1",
	language: "zh",
	account_sdk_source: "web",
	p_js_v: PASSPORT_JSSDK_VERSION,
	p_js_t: "pro",
	p_zt: "3.3.1",
	p_ver: "1.0.29",
	request_host: "https%3A%2F%2Fcreator.douyin.com",
	p_bd: "1.0.1.16",
	is_from_iesaccountsaas: "1"
};
const DEFAULT_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";
/** 创作者登录面板（vmok 420）里 tt-account-sdk 的 appKey，aid=2906 */
const CREATOR_PASSPORT_APP_KEY = "6ddd3ec693f3a124adb29b91b244ece5";
/** 抖音聊天桌面客户端（对齐 douyin-im desktop 常量） */
const DESKTOP_ORIGIN = "https://imdesktop.douyin.com";
const DESKTOP_AID = "339757";
const DESKTOP_APP_VERSION$1 = "1.2.1";
const DESKTOP_PASSPORT_APP_KEY = "3c452fb664e3de0e936108429a0bc697";
const DESKTOP_LOGIN_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) douyinim/1.2.1 Chrome/130.0.6723.58 Electron/33.2.0-rs.21.release.main.1 Safari/537.36";

//#endregion
//#region src/core/sign/aid-sign.ts
function hmacSha256Hex(key, message) {
	return createHmac("sha256", Buffer.from(key)).update(Buffer.from(message)).digest("hex");
}
function hexToBytes(hex) {
	const normalized = hex.length % 2 === 1 ? `0${hex}` : hex;
	return Uint8Array.from(Buffer.from(normalized, "hex"));
}
/** 272.js `Nl`：首包 HMAC 后按轮扩展为 32 字节（内层 `e` 固定为首包 hex） */
function derivePassportSignKey(password, salt, extra, length = 32) {
	let pw = password;
	if (pw.length === 0) {
		pw = new Uint8Array(32);
	}
	const firstHex = hmacSha256Hex(pw, salt);
	const fixedKey = hexToBytes(firstHex);
	let rollingHex = firstHex;
	const out = [];
	for (let round = 1; out.length < length; round += 1) {
		const msg = Uint8Array.from([
			...hexToBytes(rollingHex),
			...extra,
			round
		]);
		rollingHex = hmacSha256Hex(fixedKey, msg);
		out.push(...hexToBytes(rollingHex));
	}
	return Uint8Array.from(out.slice(0, length));
}
/**
* `x-tt-passport-aid-sign`（64 hex HMAC-SHA256）
* 消息：`aid={aid}&path={path}&ts={ts}`
*/
function buildPassportAidSign(input) {
	const appKey = input.appKey ?? "6ddd3ec693f3a124adb29b91b244ece5";
	const ts = input.ts ?? "";
	const enc = new TextEncoder();
	const key = derivePassportSignKey(enc.encode(ts), enc.encode(appKey), new Uint8Array(0), 32);
	const message = `aid=${input.aid}&path=${input.path}&ts=${ts}`;
	return hmacSha256Hex(key, enc.encode(message));
}
/** SSO 域名下给 path 加 `/passport/sso` 前缀；创作者站通常原样返回 */
function normalizePassportPath(path, hostname = "creator.douyin.com") {
	if (path.startsWith("/passport") || hostname.includes("sso")) {
		return path;
	}
	return `/passport/sso${path}`;
}
/** Passport 查询串 `ts`：当日 UTC 12:00:00 的 Unix 秒（与 tt-account-sdk aid-sign 中间件一致） */
function passportNoonUtcTs(date = new Date()) {
	const noon = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 12, 0, 0, 0);
	return String(Math.floor(noon / 1e3));
}

//#endregion
//#region src/core/sign/a-bogus.ts
/**
* Web 端 a_bogus（bdms）逆向算法，自参考实现 a_bogus.js V 1.0.1.20 逐行等价迁移。
* 禁止改动任何常量表与位运算，否则签名失效。
*/
const TABLES = {
	s0: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=",
	s1: "Dkdpgh4ZKsQB80/Mfvw36XI1R25+WUAlEi7NLboqYTOPuzmFjJnryx9HVGcaStCe=",
	s2: "Dkdpgh4ZKsQB80/Mfvw36XI1R25-WUAlEi7NLboqYTOPuzmFjJnryx9HVGcaStCe=",
	s3: "ckdp1h4ZKsUB80/Mfvw36XIgR25+WQAlEi7NLboqYTOPuzmFjJnryx9HVGDaStCe",
	s4: "Dkdpgh2ZmsQB80/MfvV36XI1R45-WUAlEixNLwoqYTOPuzKFjJnry79HbGcaStCe"
};
const SALT = "dhzx";
const BDMS_PRESETS = {
	"1.0.1.20": {
		constVal1: 22740,
		constVal2: 2631
	},
	"1.0.1.16": {
		constVal1: 22740,
		constVal2: 2631
	}
};
/** 与 DEFAULT_USER_AGENT（Mac）匹配的屏参 */
const MAC_SCREEN_FINGERPRINT = "1728|1117|1728|303|1728|1117|1728|982|MacIntel";
/** 参考脚本默认 Windows 指纹 */
const WIN_SCREEN_FINGERPRINT = "1920|366|1918|1048|1920|1050|1920|1080|Win32";
const DEFAULT_SCREEN_FINGERPRINT = MAC_SCREEN_FINGERPRINT;
function generateABogus(options) {
	const preset = BDMS_PRESETS[options.bdmsPreset ?? "1.0.1.16"];
	const body = options.body ?? "";
	const fpArr = strToByteArr(options.screenFingerprint ?? "1728|1117|1728|303|1728|1117|1728|982|MacIntel");
	const tm2 = new Date().getTime() - 1;
	const tm1Before = new Date().getTime();
	const queryArr32 = sm3Digest(sm3Digest(`${options.query}${SALT}`));
	const dataArr32 = sm3Digest(sm3Digest(`${body}${SALT}`));
	const keyVal = options.keyVal ?? 0;
	const userAgentLmStr = rc4Parse(String.fromCharCode(...[
		.00390625,
		1,
		keyVal
	]), options.userAgent);
	const userAgentArr32 = sm3Digest(lmStrEncode(strToByteArr(userAgentLmStr), TABLES.s3));
	const tm1 = new Date().getTime();
	const arr50 = [
		41,
		9,
		6,
		tm1 - tm1Before + 3 & 255,
		tm1 >> 0 & 255,
		tm1 >> 8 & 255,
		tm1 >> 16 & 255,
		tm1 >> 24 & 255,
		tm1 / 256 / 256 / 256 / 256 & 255,
		tm1 / 256 / 256 / 256 / 256 / 256 & 255,
		1 & 255,
		Math.floor(1 / 256) & 255,
		129,
		129 >> 8 & 255,
		(Math.random() * 200 | 0) + 50,
		(Math.random() * 200 | 0) + 50,
		(Math.random() * 200 | 0) + 50,
		(Math.random() * 200 | 0) + 50,
		keyVal >> 0 & 255,
		keyVal >> 8 & 255,
		keyVal >> 16 & 255,
		keyVal >> 24 & 255,
		queryArr32[9],
		queryArr32[18],
		queryArr32[3],
		dataArr32[10],
		dataArr32[19],
		dataArr32[4],
		userAgentArr32[11],
		userAgentArr32[21],
		userAgentArr32[5],
		tm2 >> 0 & 255,
		tm2 >> 8 & 255,
		tm2 >> 16 & 255,
		tm2 >> 24 & 255,
		tm2 / 256 / 256 / 256 / 256 & 255,
		tm2 / 256 / 256 / 256 / 256 / 256 & 255,
		3,
		preset.constVal1 >> 0 & 255,
		preset.constVal1 >> 8 & 255,
		preset.constVal1 >> 16 & 255,
		preset.constVal1 >> 24 & 255,
		preset.constVal2 >> 0 & 255,
		preset.constVal2 >> 8 & 255,
		preset.constVal2 >> 16 & 255,
		preset.constVal2 >> 24 & 255,
		44,
		0,
		4,
		0
	];
	const newArr50 = reorderArr50(arr50);
	const xorRandomArr8 = xorRandomArr8Gen();
	const xorArray = xorFold([...xorRandomArr8, ...arr50]);
	const arr4Merge = [
		...newArr50,
		...fpArr,
		...tmArr(tm1),
		...xorArray
	];
	let aBogusLmStr = String.fromCharCode(...aBogusPrefix4());
	const mergeArr = [];
	for (let i = 0; i < arr4Merge.length / 3; i++) {
		const val1 = arr4Merge[3 * i];
		const val2 = arr4Merge[3 * i + 1];
		const val3 = arr4Merge[3 * i + 2];
		const randomVal = Math.random() * 1e3 & 255;
		mergeArr.push(randomVal & 145 | val1 & 110, randomVal & 66 | val2 & 189, randomVal & 44 | val3 & 211, val1 & 145 | val2 & 66 | val3 & 44);
	}
	const bigArr = [
		...xorRandomArr8,
		...mergeArr,
		...xorArray
	];
	aBogusLmStr += rc4Parse(String.fromCharCode(211), String.fromCharCode(...bigArr));
	return lmStrEncode(strToByteArr(aBogusLmStr), TABLES.s4);
}
/** jumpbyte-bot internal/abogus 的逐步骤移植，仅供 desktop Passport 使用 */
function generateJumpbyteABogus(options) {
	const now = options.nowMs ?? Date.now();
	const random = options.random ?? cryptoRandomFloat;
	const query = `${options.query}${SALT}`;
	const body = `${options.body ?? ""}${SALT}`;
	const queryHash = sm3Digest(sm3Digest(query));
	const bodyHash = sm3Digest(sm3Digest(body));
	const uaHash = sm3Digest(lmStrEncode(jumpbyteGarble(jumpbyteUaSbox(0), encodeUtf8ForSm3(options.userAgent)), TABLES.s3));
	const fixed = encodeUtf8ForSm3("784|943|1707|1019|1707|1019|1707|1067|MacIntel");
	const dateBucket = Math.trunc((now - 17218368e5) / 12096e5);
	const firstTime = now;
	const secondTime = firstTime - Math.trunc(random() * 10);
	const prefix = jumpbyteRandomPrefix(random);
	const arr = new Array(55).fill(0);
	arr[0] = 41;
	arr[1] = dateBucket;
	arr[2] = 5;
	arr[3] = firstTime - secondTime + 3 & 255;
	for (let i = 0; i < 6; i++) arr[4 + i] = byteAt(firstTime, i);
	arr[10] = 1;
	arr[12] = 1;
	arr[14] = 1;
	arr[22] = queryHash[9];
	arr[23] = queryHash[18];
	arr[24] = 3;
	arr[25] = queryHash[3];
	arr[26] = bodyHash[10];
	arr[27] = bodyHash[19];
	arr[28] = 4;
	arr[29] = bodyHash[4];
	arr[30] = uaHash[11];
	arr[31] = uaHash[21];
	arr[32] = 5;
	arr[33] = uaHash[5];
	for (let i = 0; i < 6; i++) arr[34 + i] = byteAt(secondTime, i);
	arr[40] = 3;
	writeInt32LE(arr, 41, 6241);
	writeInt32LE(arr, 45, 6383);
	const lastTime = encodeUtf8ForSm3(`${firstTime + 3 & 255},`);
	arr[49] = fixed.length;
	arr[50] = fixed.length & 255;
	arr[51] = fixed.length >> 8 & 255;
	arr[52] = lastTime.length;
	arr[53] = lastTime.length & 255;
	arr[54] = lastTime.length >> 8 & 255;
	const checksumIndexes = [
		0,
		1,
		2,
		3,
		4,
		5,
		6,
		7,
		8,
		9,
		10,
		11,
		12,
		13,
		14,
		15,
		16,
		17,
		18,
		19,
		20,
		21,
		22,
		23,
		25,
		26,
		27,
		29,
		30,
		31,
		33,
		34,
		35,
		36,
		37,
		38,
		39,
		40,
		41,
		42,
		43,
		44,
		45,
		46,
		47,
		48,
		50,
		51,
		53,
		54
	];
	let checksum = prefix.reduce((value, item) => value ^ item, 0);
	for (const index of checksumIndexes) checksum ^= arr[index];
	const order = [
		9,
		18,
		30,
		35,
		47,
		4,
		44,
		19,
		10,
		23,
		12,
		40,
		25,
		42,
		3,
		22,
		38,
		21,
		5,
		45,
		1,
		29,
		6,
		43,
		33,
		14,
		36,
		37,
		2,
		46,
		15,
		48,
		31,
		26,
		16,
		13,
		8,
		41,
		27,
		17,
		39,
		20,
		11,
		0,
		34,
		7,
		50,
		51,
		53,
		54
	];
	const ordered = order.map((index) => arr[index]);
	const payload = jumpbyteExpand(prefix, [
		...ordered,
		...fixed,
		...lastTime,
		checksum
	], random);
	const header = jumpbyteHeader(random);
	const encrypted = jumpbyteGarble(jumpbyteAbSbox(), payload);
	return lmStrEncode([...header, ...encrypted], TABLES.s4);
}
function jumpbyteExpand(prefix, input, random) {
	const output = [...prefix];
	for (let i = 0; i < input.length; i += 3) {
		if (i + 2 >= input.length) {
			output.push(...input.slice(i));
			break;
		}
		const value = Math.trunc(random() * 1e3) & 255;
		const first = input[i];
		const second = input[i + 1];
		const third = input[i + 2];
		output.push(value & 145 | first & 110, value & 66 | second & 189, value & 44 | third & 211, first & 145 | second & 66 | third & 44);
	}
	return output;
}
function jumpbyteHeader(random) {
	const first = Math.trunc(random() * 65535) & 255;
	const second = Math.trunc(random() * 40);
	return [
		first & 170 | 3 & 85,
		first & 85 | 3 & 170,
		second & 170 | 82 & 85,
		second & 85 | 82 & 170
	];
}
function jumpbyteRandomPrefix(random) {
	const first = Math.trunc(random() * 65535);
	const low = first & 255;
	const high = first >> 8 & 255;
	const second = Math.trunc(random() * 240);
	const third = Math.trunc(random() * 255) & 77 | 2 | 16 | 32 | 128;
	return [
		low & 170 | 1 & 85,
		low & 85 | 1 & 170,
		high & 170 | 0 & 85,
		high & 85 | 0 & 170,
		second & 170 | 1 & 85,
		second & 85 | 1 & 170,
		third & 170 | 0 & 85,
		third & 85 | 0 & 170
	];
}
function jumpbyteAbSbox() {
	return jumpbyteSbox([211]);
}
function jumpbyteUaSbox(salt) {
	return jumpbyteSbox([
		0,
		1,
		salt
	]);
}
function jumpbyteSbox(key) {
	const values = Array.from({ length: 256 }, (_, index) => 255 - index);
	let previous = 0;
	for (let i = 0; i < 256; i++) {
		previous = (previous * values[i] + previous + key[i % key.length]) % 256;
		[values[i], values[previous]] = [values[previous], values[i]];
	}
	return values;
}
function jumpbyteGarble(sbox, input) {
	let previous = 0;
	return input.map((value, index) => {
		const cursor = (index + 1) % 256;
		previous = (previous + sbox[cursor]) % 256;
		const old = sbox[cursor];
		sbox[cursor] = sbox[previous];
		sbox[previous] = old;
		return value ^ sbox[(sbox[cursor] + old) % 256];
	});
}
function byteAt(value, index) {
	return Number(BigInt(Math.trunc(value)) >> BigInt(index * 8) & 255n);
}
function writeInt32LE(target, offset, value) {
	for (let i = 0; i < 4; i++) target[offset + i] = value >> i * 8 & 255;
}
function cryptoRandomFloat() {
	const value = randomBytes(8).readBigUInt64BE() >> 11n;
	return Number(value) / 9007199254740992;
}
function lmStrEncode(bytes, table) {
	let out = "";
	const groupNum = bytes.length / 3;
	for (let i = 0; i < groupNum; i++) {
		const b1 = bytes[3 * i] & 255;
		const b2 = bytes[3 * i + 1] & 255;
		const b3 = bytes[3 * i + 2] & 255;
		const big = b1 << 16 | b2 << 8 | b3;
		out += table.charAt((big & 16515072) >> 18);
		out += table.charAt((big & 258048) >> 12);
		out += table.charAt((big & 4032) >> 6);
		out += table.charAt(big & 63);
	}
	const rem = bytes.length % 3;
	if (rem === 1) {
		out = out.substring(0, out.length - 2) + "==";
	} else if (rem === 2) {
		out = out.substring(0, out.length - 1) + "=";
	}
	return out;
}
function rc4Parse(key, data) {
	const sbox = Array.from({ length: 256 }, (_, i) => 255 - i);
	let j = 0;
	for (let i = 0; i < 256; i++) {
		j = (j * sbox[i] + j + key.charCodeAt(i % key.length)) % 256;
		const tmp = sbox[i];
		sbox[i] = sbox[j];
		sbox[j] = tmp;
	}
	let out = "";
	let prev = 0;
	for (let i = 0; i < data.length; i++) {
		const idx = (i + 1) % 256;
		const idx2 = (prev + sbox[idx]) % 256;
		const idx3 = (sbox[idx2] + sbox[idx]) % 256;
		prev = idx2;
		const t1 = sbox[idx];
		sbox[idx] = sbox[idx2];
		sbox[idx2] = t1;
		out += String.fromCharCode(data.charCodeAt(i) ^ sbox[idx3]);
	}
	return out;
}
function strToByteArr(s) {
	return Array.from(s, (c) => c.charCodeAt(0));
}
function tmArr(tm) {
	const tmNum = tm + 3 & 255;
	const tmStr = `${tmNum},`;
	return strToByteArr(tmStr);
}
function aBogusPrefix4() {
	const r1 = Math.random() * 65535 & 255;
	const r2 = Math.random() * 40;
	return [
		r1 & 170 | 1,
		r1 & 85 | 2,
		r2 >> 0 & 170 | 80,
		r2 >> 0 & 85 | 2
	];
}
function xorRandomArr8Gen() {
	const r1 = Math.random() * 65535;
	const t1 = r1 & 255;
	const t2 = r1 >> 8 & 255;
	const n1 = t1 & 170 | 1;
	const n2 = t1 & 85 | 0;
	const n3 = t2 & 170 | 0;
	const n4 = t2 & 85 | 0;
	const randomVal = Math.random() * 255;
	let isEven = Math.random() * 240 + 110;
	if (isEven % 2 !== 0) isEven++;
	const n5 = isEven & 170 | 1;
	const n6 = isEven & 85 | 0;
	const n7 = (randomVal >> 0 & 77 | 2 | 16 | 32 | 128) & 170 | 16;
	const n8 = (randomVal >> 0 & 77 | 16 | 32 | 128) & 85 | 2;
	return [
		n1,
		n2,
		n3,
		n4,
		n5,
		n6,
		n7,
		n8
	];
}
function reorderArr50(arr50) {
	const o = new Array(50);
	o[0] = arr50[9];
	o[1] = arr50[18];
	o[2] = arr50[28];
	o[3] = arr50[32];
	o[4] = arr50[11];
	o[5] = arr50[4];
	o[6] = arr50[11];
	o[7] = arr50[11];
	o[8] = arr50[9];
	o[9] = arr50[23];
	o[10] = arr50[12];
	o[11] = arr50[37];
	o[12] = arr50[24];
	o[13] = arr50[39];
	o[14] = arr50[3];
	o[15] = arr50[22];
	o[16] = arr50[35];
	o[17] = arr50[11];
	o[18] = arr50[5];
	o[19] = arr50[42];
	o[20] = arr50[1];
	o[21] = arr50[27];
	o[22] = arr50[33];
	o[23] = arr50[11];
	o[24] = arr50[30];
	o[25] = arr50[14];
	o[26] = arr50[6];
	o[27] = arr50[7];
	o[28] = arr50[2];
	o[29] = arr50[43];
	o[30] = arr50[15];
	o[31] = arr50[11];
	o[32] = arr50[29];
	o[33] = arr50[25];
	o[34] = arr50[16];
	o[35] = arr50[11];
	o[36] = arr50[8];
	o[37] = arr50[38];
	o[38] = arr50[26];
	o[39] = arr50[17];
	o[40] = arr50[9];
	o[41] = arr50[11];
	o[42] = arr50[11];
	o[43] = arr50[0];
	o[44] = arr50[31];
	o[45] = arr50[7];
	o[46] = arr50[46];
	o[47] = arr50[47];
	o[48] = arr50[48];
	o[49] = arr50[49];
	return o;
}
function xorFold(arr) {
	let x = 0;
	for (const v of arr) x ^= v;
	return [x];
}
function sm3Digest(data) {
	const bytes = typeof data === "string" ? encodeUtf8ForSm3(data) : data;
	const h = new Sm3();
	return h.sum(bytes);
}
function encodeUtf8ForSm3(text) {
	const encoded = encodeURIComponent(text).replace(/%([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
	return Array.from(encoded, (c) => c.charCodeAt(0));
}
var Sm3 = class {
	reg = [];
	chunk = [];
	size = 0;
	reset() {
		this.reg = [
			1937774191,
			1226093241,
			388252375,
			3666478592,
			2842636476,
			372324522,
			3817729613,
			2969243214
		];
		this.chunk = [];
		this.size = 0;
	}
	write(data) {
		this.size += data.length;
		let r = 64 - this.chunk.length;
		if (data.length < r) {
			this.chunk = this.chunk.concat(data);
			return;
		}
		this.chunk = this.chunk.concat(data.slice(0, r));
		while (this.chunk.length >= 64) {
			this.compressBlock(this.chunk);
			if (r < data.length) {
				this.chunk = data.slice(r, Math.min(r + 64, data.length));
			} else {
				this.chunk = [];
			}
			r += 64;
		}
	}
	sum(data) {
		this.reset();
		if (data.length) {
			this.write(data);
		}
		this.fill();
		for (let i = 0; i < this.chunk.length; i += 64) {
			this.compressBlock(this.chunk.slice(i, i + 64));
		}
		const out = new Array(32);
		for (let i = 0; i < 8; i++) {
			let c = this.reg[i];
			out[4 * i + 3] = c & 255;
			c >>>= 8;
			out[4 * i + 2] = c & 255;
			c >>>= 8;
			out[4 * i + 1] = c & 255;
			c >>>= 8;
			out[4 * i] = c & 255;
		}
		this.reset();
		return out;
	}
	fill() {
		const bitLen = 8 * this.size;
		let e = this.chunk.push(128) % 64;
		for (; 64 - e < 8; e -= 64) {}
		for (; e < 56; e++) {
			this.chunk.push(0);
		}
		for (let i = 0; i < 4; i++) {
			const n = Math.floor(bitLen / 4294967296);
			this.chunk.push(n >>> 8 * (3 - i) & 255);
		}
		for (let i = 0; i < 4; i++) {
			this.chunk.push(bitLen >>> 8 * (3 - i) & 255);
		}
	}
	compressBlock(block) {
		const w = expand(block);
		const r = this.reg.slice();
		for (let j = 0; j < 64; j++) {
			let o = rotl(r[0], 12) + r[4] + rotl(tj(j), j);
			o = rotl((o & 4294967295) >>> 0, 7);
			const i = ((o ^ rotl(r[0], 12)) & 4294967295) >>> 0;
			let u = ff(j, r[0], r[1], r[2]) + r[3] + i + w[j + 68] & 4294967295;
			u >>>= 0;
			let c = gg(j, r[4], r[5], r[6]) + r[7] + o + w[j] & 4294967295;
			c >>>= 0;
			r[3] = r[2];
			r[2] = rotl(r[1], 9);
			r[1] = r[0];
			r[0] = u;
			r[7] = r[6];
			r[6] = rotl(r[5], 19);
			r[5] = r[4];
			r[4] = (c ^ rotl(c, 9) ^ rotl(c, 17)) >>> 0;
		}
		for (let a = 0; a < 8; a++) {
			this.reg[a] = (this.reg[a] ^ r[a]) >>> 0;
		}
	}
};
function rotl(x, n) {
	n %= 32;
	return (x << n | x >>> 32 - n) >>> 0;
}
/** 与参考 a_bogus.js / bdms 内嵌 SM3 一致（非国标 Tj 低段常量） */
function tj(j) {
	return j < 16 ? 2043430169 : 2055708042;
}
function ff(j, a, b, c) {
	return j < 16 ? (a ^ b ^ c) >>> 0 : (a & b | a & c | b & c) >>> 0;
}
function gg(j, a, b, c) {
	return j < 16 ? (a ^ b ^ c) >>> 0 : (a & b | ~a & c) >>> 0;
}
function expand(block) {
	const w = new Array(132).fill(0);
	for (let i = 0; i < 16; i++) {
		w[i] = (block[4 * i] << 24 | block[4 * i + 1] << 16 | block[4 * i + 2] << 8 | block[4 * i + 3]) >>> 0;
	}
	for (let i = 16; i < 68; i++) {
		let t = w[i - 16] ^ w[i - 9] ^ rotl(w[i - 3], 15);
		t = (t ^ rotl(t, 15) ^ rotl(t, 23)) >>> 0;
		w[i] = (t ^ rotl(w[i - 13], 7) ^ w[i - 6]) >>> 0;
	}
	for (let i = 0; i < 64; i++) {
		w[i + 68] = (w[i] ^ w[i + 4]) >>> 0;
	}
	return w;
}

//#endregion
//#region src/core/sign/sign-qs.ts
function sortedParamString(obj, keepFirstN) {
	let keys = Object.keys(obj).sort();
	if (keepFirstN !== undefined && keepFirstN >= 0) {
		keys = keys.slice(0, keepFirstN);
	}
	const str = keys.map((k) => {
		const v = obj[k];
		const val = typeof v === "object" && v !== null ? JSON.stringify(v) : String(v);
		return `${k}=${val}`;
	}).join("&");
	return {
		str,
		keys
	};
}
/** qs：对「排序后前 10 个 query 键名」逗号拼接，再 UTF-8 + 每字节 XOR 5 → hex（无补零） */
function encodeQsKeyNames(keyNames) {
	const input = keyNames.join(",");
	const out = [];
	for (let i = 0; i < input.length; i++) {
		const cp = input.charCodeAt(i);
		const bytes = [];
		if (cp >= 0 && cp <= 127) {
			bytes.push(cp);
		} else if (cp >= 128 && cp <= 2047) {
			bytes.push(192 | 31 & cp >> 6, 128 | 63 & cp);
		} else if (cp >= 2048 && cp <= 55295 || cp >= 57344 && cp <= 65535) {
			bytes.push(224 | 15 & cp >> 12, 128 | 63 & cp >> 6, 128 | 63 & cp);
		}
		for (const b of bytes) {
			out.push((5 ^ b).toString(16));
		}
	}
	return out.join("");
}
/**
* 复现 tt-account-sdk 请求拦截器 `d(query, body, appKey)`：
* sign = sha256(排序 query 前 10 项 & body & app_key)
*/
function buildPassportSignQs(input) {
	const appKey = input.appKey ?? "6ddd3ec693f3a124adb29b91b244ece5";
	const body = input.body ?? {};
	const { str: queryStr, keys } = sortedParamString(input.query, 10);
	const { str: bodyStr } = sortedParamString(body);
	const payload = `${queryStr}&${bodyStr}&app_key=${appKey}`;
	const sign = createHash("sha256").update(payload, "utf8").digest("hex");
	const qs = encodeQsKeyNames(keys);
	return {
		sign,
		qs
	};
}
/** 将 application/x-www-form-urlencoded 解析为签名用的 body 对象（值已 decode） */
function parseFormBodyForSign(body) {
	const out = {};
	if (!body) return out;
	for (const part of body.split("&")) {
		const eq = part.indexOf("=");
		if (eq === -1) {
			out[decodeURIComponent(part)] = "";
		} else {
			out[decodeURIComponent(part.slice(0, eq))] = decodeURIComponent(part.slice(eq + 1));
		}
	}
	return out;
}
function randomBizTraceId() {
	return randomBytes(4).toString("hex");
}
/** 不含 sign/qs/msToken/a_bogus 的 Passport 基础查询对象 */
function buildPassportBaseQuery(opts = {}) {
	const ts = opts.ts ?? passportNoonUtcTs();
	const bizTraceId = opts.bizTraceId ?? randomBizTraceId();
	const query = {
		...PASSPORT_SDK_META,
		aid: CREATOR_AID,
		ts,
		biz_trace_id: bizTraceId,
		is_new_login: opts.isNewLogin ?? "1",
		account_sdk_source_info: opts.accountSdkSourceInfo ?? "",
		...opts.extra
	};
	if (opts.next) {
		query.next = opts.next;
	}
	return query;
}
function signPassportQuery(baseQuery, body = {}, extras) {
	const signInput = {
		query: baseQuery,
		body
	};
	if (extras?.appKey) signInput.appKey = extras.appKey;
	const { sign, qs } = buildPassportSignQs(signInput);
	const query = {
		...baseQuery,
		sign,
		qs
	};
	if (extras?.msToken) {
		query.msToken = extras.msToken;
	}
	const manualAbogus = extras?.aBogus;
	const compute = !manualAbogus && extras?.enableABogus !== false && Boolean(extras?.userAgent);
	if (manualAbogus) {
		query.a_bogus = manualAbogus;
	} else if (compute) {
		const queryForAbogus = new URLSearchParams(query).toString();
		const abOpts = {
			userAgent: extras.userAgent,
			query: queryForAbogus,
			body: extras?.bodyWire ?? ""
		};
		if (extras?.screenFingerprint) {
			abOpts.screenFingerprint = extras.screenFingerprint;
		}
		if (extras?.bdmsPreset) {
			abOpts.bdmsPreset = extras.bdmsPreset;
		}
		query.a_bogus = extras?.aBogusVariant === "jumpbyte-desktop" ? generateJumpbyteABogus({
			userAgent: abOpts.userAgent,
			query: abOpts.query,
			body: abOpts.body ?? ""
		}) : generateABogus(abOpts);
	}
	const search = new URLSearchParams(query).toString();
	return {
		query,
		search
	};
}
function encodeFormBody(body) {
	return Object.keys(body).map((key) => {
		const value = body[key] ?? "";
		return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
	}).join("&");
}
function passportUrl(path, search) {
	const normalized = path.startsWith("/") ? path : `/${path}`;
	return `${CREATOR_ORIGIN}${normalized}?${search}`;
}
function desktopPassportUrl(path, search) {
	const normalized = path.startsWith("/") ? path : `/${path}`;
	return `${DESKTOP_ORIGIN}${normalized}?${search}`;
}
/** 桌面 normal SDK（2.4.12）Passport 基础查询，字段顺序对齐 douyin-im（a_bogus 对顺序敏感） */
function buildDesktopPassportBaseQuery(opts) {
	return {
		passport_jssdk_version: "2.4.12",
		passport_jssdk_type: "normal",
		is_from_ttaccountsdk: "1",
		aid: DESKTOP_AID,
		language: "zh",
		ts: passportNoonUtcTs(),
		...opts.next ? { next: opts.next } : {},
		...opts.extra ?? {},
		is_new_login: "1",
		is_from_iesaccountsaas: "1",
		account_sdk_source: "web",
		account_sdk_source_info: opts.accountSdkSourceInfo ?? "",
		p_js_v: "2.4.12",
		p_js_t: "pro",
		p_zt: "3.3.5",
		p_ver: "1.0.29",
		request_host: "file://",
		p_bd: "1.0.1.7",
		biz_trace_id: opts.bizTraceId ?? randomBizTraceId(),
		device_id: opts.deviceId,
		iid: opts.installId,
		version_code: DESKTOP_APP_VERSION$1,
		device_platform: "PC"
	};
}
/** jumpbyte desktop canonical 参数顺序（form/query 编码用） */
const DESKTOP_PARAM_ORDER = {
	passport_jssdk_version: 0,
	passport_jssdk_type: 1,
	is_from_ttaccountsdk: 2,
	aid: 3,
	language: 4,
	account_app_language: 5,
	ts: 6,
	next: 7,
	need_logo: 8,
	need_short_url: 9,
	is_new_login: 10,
	is_from_iesaccountsaas: 11,
	account_sdk_source: 12,
	account_sdk_source_info: 13,
	p_js_v: 14,
	p_js_t: 15,
	p_zt: 16,
	p_ver: 17,
	request_host: 18,
	p_bd: 19,
	biz_trace_id: 20,
	new_authn_sdk_version: 21,
	device_id: 22,
	iid: 23,
	version_code: 24,
	device_platform: 25,
	sign: 100,
	qs: 101,
	msToken: 102,
	a_bogus: 103
};
/** desktop 端 Passport 参数编码：按 jumpbyte canonical 顺序输出 form/query 串 */
function encodeDesktopPassportParams(params) {
	return Object.keys(params).sort((left, right) => {
		const leftOrder = DESKTOP_PARAM_ORDER[left];
		const rightOrder = DESKTOP_PARAM_ORDER[right];
		if (leftOrder != null && rightOrder != null) return leftOrder - rightOrder;
		if (leftOrder != null) return -1;
		if (rightOrder != null) return 1;
		return left < right ? -1 : left > right ? 1 : 0;
	}).map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(params[key] ?? "")}`).join("&");
}
const RANDOM_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
/** 128 位随机 msToken（desktop lite 接口用） */
function randomMsToken128(length = 128) {
	return [...randomBytes(length)].map((value) => RANDOM_ALPHABET[value & 63]).join("");
}
/** 随机 hex（desktop biz_trace_id/device_id 用） */
function randomDesktopHex(length) {
	return [...randomMsToken128(length)].map((value) => "0123456789abcdef"[value.charCodeAt(0) & 15]).join("");
}

//#endregion
//#region src/core/http/client.ts
/**
* 抖音 HTTP 客户端（creator-web）：Cookie/UA/超时封装 + Passport 请求头 + 标准参数。
* 仅纯 HTTP 部分，登录流程由上层组装。
*/
var DouyinHttp = class {
	jar;
	enableABogus;
	enableAutoAidSign;
	bizTraceId;
	/** 服务端注册的桌面设备身份（登录时注入；'0' 表示未注册） */
	deviceId = "0";
	installId = "0";
	guid = randomDesktopHex(32);
	requestTimeoutMs;
	userAgent;
	verifyPortrait = `${randomUUID()}.login`;
	constructor(config = {}) {
		this.requestTimeoutMs = config.requestTimeoutMs ?? 3e4;
		if (!Number.isSafeInteger(this.requestTimeoutMs) || this.requestTimeoutMs <= 0 || this.requestTimeoutMs > 2147483647) {
			throw new RangeError("requestTimeoutMs must be an integer between 1 and 2147483647");
		}
		this.jar = new CookieJar(config.initialCookies);
		this.userAgent = config.userAgent ?? "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";
		this.enableABogus = config.enableABogus ?? true;
		this.enableAutoAidSign = config.enableAutoAidSign ?? true;
		if (config.msToken != null) this.jar.set("msToken", config.msToken);
		this.bizTraceId = config.bizTraceId ?? this.jar.get("biz_trace_id") ?? randomBizTraceId();
		if (!this.jar.has("biz_trace_id")) this.jar.set("biz_trace_id", this.bizTraceId);
	}
	getCookies() {
		return this.jar.toHeader();
	}
	setMsToken(value) {
		this.jar.set("msToken", value);
	}
	getMsToken() {
		return this.jar.get("msToken");
	}
	getUserAgent() {
		return this.userAgent;
	}
	/** 注入服务端注册的桌面设备身份（device_register 签发） */
	setDevice(device) {
		this.deviceId = device.deviceId;
		this.installId = device.installId;
		this.guid = device.guid;
	}
	hasDesktopDevice() {
		return this.deviceId !== "0" && /^\d+$/.test(this.deviceId);
	}
	/** 创作者平台标准查询参数（浏览器兼容格式） */
	buildStandardParams() {
		const params = new URLSearchParams({
			aid: "2906",
			app_name: "aweme_creator_platform",
			device_platform: "web",
			referer: "",
			user_agent: this.userAgent,
			cookie_enabled: "true",
			screen_width: "1512",
			screen_height: "982",
			browser_language: "zh-CN",
			browser_platform: "MacIntel",
			browser_name: "Mozilla",
			browser_version: this.userAgent.replace(/^Mozilla\//, ""),
			browser_online: "true",
			timezone_name: "Asia/Shanghai"
		});
		const msToken = this.getMsToken();
		if (msToken) params.set("msToken", msToken);
		return params;
	}
	/** Passport 接口请求头；imdesktop（桌面客户端）与 creator（创作者 web）分流 */
	passportHeaders(requestUrl) {
		const desktop = Boolean(requestUrl?.startsWith(DESKTOP_ORIGIN));
		const headers = {
			Accept: "application/json, text/javascript",
			Referer: desktop ? DESKTOP_ORIGIN : `${CREATOR_ORIGIN}/creator-micro/home`
		};
		const csrf = this.jar.get("passport_csrf_token") ?? this.jar.get("passport_csrf_token_default");
		if (csrf) headers["x-tt-passport-csrf-token"] = csrf;
		headers["x-tt-passport-trace-id"] = this.bizTraceId;
		const aidSign = this.resolveAidSign(requestUrl, desktop);
		if (aidSign) headers["x-tt-passport-aid-sign"] = aidSign;
		if (desktop) {
			headers["x-tt-passport-verify-portrait"] = this.verifyPortrait;
			return headers;
		}
		const secsdk = buildSecsdkCsrfToken(this.jar.get("x-web-secsdk-uid"));
		if (secsdk) headers["x-secsdk-csrf-token"] = secsdk;
		headers["x-tt-passport-verify-portrait"] = this.verifyPortrait;
		return headers;
	}
	resolveAidSign(requestUrl, desktop = false) {
		if (!this.enableAutoAidSign || !requestUrl) return undefined;
		try {
			const path = new URL(requestUrl).pathname;
			return buildPassportAidSign({
				aid: desktop ? DESKTOP_AID : CREATOR_AID,
				appKey: desktop ? DESKTOP_PASSPORT_APP_KEY : CREATOR_PASSPORT_APP_KEY,
				path: normalizePassportPath(path),
				ts: passportNoonUtcTs()
			});
		} catch {
			return undefined;
		}
	}
	async requestRaw(url, init = {}) {
		const res = await this.fetchResponse(url, init);
		const rawText = await res.text();
		const path = new URL(url, "https://douyin.invalid").pathname;
		logger.debug(`[douyin:http] ${(init.method ?? "GET").toUpperCase()} ${res.status} ${path}${rawText ? ` 响应: ${rawText.length > 5e3 ? `${rawText.slice(0, 5e3)}...(截断,共${rawText.length}字符)` : rawText}` : "(空)"}`);
		return {
			ok: res.ok,
			status: res.status,
			headers: res.headers,
			data: rawText,
			rawText
		};
	}
	async requestJson(url, init = {}) {
		const res = await this.requestRaw(url, init);
		const data = parseJsonResponse(res, url);
		return {
			...res,
			data
		};
	}
	async requestBytes(url, init = {}) {
		const res = await this.fetchResponse(url, init);
		const data = new Uint8Array(await res.arrayBuffer());
		const path = new URL(url, "https://douyin.invalid").pathname;
		const hexHead = [...data.slice(0, 256)].map((b) => b.toString(16).padStart(2, "0")).join("");
		logger.debug(`[douyin:http] ${(init.method ?? "GET").toUpperCase()} ${res.status} ${path} (${data.byteLength} bytes) hex[${Math.min(256, data.byteLength)}]: ${hexHead}${data.byteLength > 256 ? "..." : ""}`);
		return {
			ok: res.ok,
			status: res.status,
			headers: res.headers,
			data
		};
	}
	async fetchResponse(url, init) {
		const cookie = this.jar.toHeader();
		const headers = {
			"User-Agent": this.userAgent,
			...init.headers
		};
		if (cookie) headers.Cookie = cookie;
		const res = await fetch(url, {
			...init,
			headers,
			signal: init.signal ?? AbortSignal.timeout(this.requestTimeoutMs)
		});
		this.absorbSetCookie(res.headers);
		const msHeader = res.headers.get("x-ms-token");
		if (msHeader) this.setMsToken(msHeader);
		return res;
	}
	absorbSetCookie(headers) {
		const list = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : collectSetCookieFallback(headers);
		for (const line of list) {
			this.jar.mergeSetCookie(line);
		}
	}
};
function collectSetCookieFallback(headers) {
	const raw = headers.raw?.();
	if (!raw?.["set-cookie"]) {
		const single = headers.get("set-cookie");
		return single ? [single] : [];
	}
	return raw["set-cookie"];
}
/** 常见形态：`000100000001` + `x-web-secsdk-uid` 去连字符 */
function buildSecsdkCsrfToken(webSecsdkUid) {
	if (!webSecsdkUid) return undefined;
	return `000100000001${webSecsdkUid.replace(/-/g, "")}`;
}

//#endregion
//#region src/core/store/account.ts
const SESSION_FILE = "session.json";
/** 账号会话持久化：每个账号一个目录 `<accountsDir>/<platformUid>/session.json` */
var AccountStore = class {
	accountsDir;
	constructor(options = {}) {
		this.accountsDir = options.accountsDir ?? join(process.cwd(), "data", "accounts");
		mkdirSync(this.accountsDir, { recursive: true });
	}
	/** 读取单个账号；不存在返回 undefined */
	load(platformUid) {
		const file = join(this.accountsDir, platformUid, SESSION_FILE);
		if (!existsSync(file)) return undefined;
		return JSON.parse(readFileSync(file, "utf8"));
	}
	/** 写入/覆盖账号 */
	save(platformUid, data) {
		const dir = join(this.accountsDir, platformUid);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, SESSION_FILE), JSON.stringify(data, null, 2));
	}
	/** 更新 ticket_guard 密钥（ImClient 持久化用） */
	updateTicketGuard(platformUid, record) {
		const prev = this.load(platformUid);
		if (!prev) return;
		this.save(platformUid, {
			...prev,
			ticketGuard: record,
			updatedAt: new Date().toISOString()
		});
	}
	/** Desktop IM 稳定设备 ID（324+7 位数字）；无则生成并立即落盘 */
	ensureDeviceId(platformUid) {
		const current = this.load(platformUid)?.session.deviceId?.trim();
		if (current) return current;
		const deviceId = `324${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;
		const record = this.load(platformUid);
		if (record) {
			this.save(platformUid, {
				...record,
				session: {
					...record.session,
					deviceId
				},
				updatedAt: new Date().toISOString()
			});
		}
		return deviceId;
	}
	/** 列出所有已落盘账号 */
	list() {
		if (!existsSync(this.accountsDir)) return [];
		return readdirSync(this.accountsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => this.load(d.name)).filter((a) => a !== undefined);
	}
	/** 删除账号目录 */
	remove(platformUid) {
		rmSync(join(this.accountsDir, platformUid), {
			recursive: true,
			force: true
		});
	}
};

//#endregion
//#region src/core/store/session-health.ts
/**
* 解析 `sid_guard` cookie：`<sid>|<issued_unix>|<ttl_sec>|<expire_date>`
* 返回距过期剩余秒数。
*/
function parseSidGuardTtl(cookies) {
	const match = cookies.match(/sid_guard=([^;]+)/);
	if (!match) return undefined;
	const decoded = decodeURIComponent(match[1]);
	const parts = decoded.split("|");
	if (parts.length < 3) return undefined;
	const issuedAt = parseInt(parts[1], 10);
	const ttlSec = parseInt(parts[2], 10);
	if (isNaN(issuedAt) || isNaN(ttlSec)) return undefined;
	const expiresAt = issuedAt + ttlSec;
	return expiresAt - Math.floor(Date.now() / 1e3);
}
/** 检查 Session 健康状态（不走网络，纯本地解析） */
function checkSessionHealth(account) {
	const remaining = parseSidGuardTtl(account.session.cookies);
	const expired = remaining !== undefined && remaining <= 0;
	const result = { expired };
	if (remaining !== undefined) result.remainingSec = remaining;
	return result;
}

//#endregion
//#region src/core/store/wake.ts
/**
* tryRestoreSession 的本地纯逻辑段：无账号 / cookies 为空 → `missing`；
* sid_guard 本地已过期 → `expired`；返回 undefined 表示本地健康，
* 是否真正可用需上层构建 client 后走网络验证确认（依赖层留待后续任务）。
*/
function evaluateLocalRestore(account) {
	if (!account?.session.cookies?.trim()) return "missing";
	if (checkSessionHealth(account).expired) return "expired";
	return undefined;
}

//#endregion
//#region src/core/auth/bootstrap.ts
/** GET /aweme/v1/web/user/profile/self/ — 桌面 IM 自我资料（对齐 douyin-im getSelfProfile） */
async function fetchDesktopSelfProfile(http) {
	const params = new URLSearchParams({
		aid: "339757",
		version_name: DESKTOP_APP_VERSION$1,
		version_code: DESKTOP_APP_VERSION$1,
		device_platform: "win32",
		screen_width: "1707",
		screen_height: "1067",
		browser_language: "zh-CN",
		browser_platform: "Win32",
		browser_name: "Mozilla",
		browser_version: http.getUserAgent().replace(/^Mozilla\//, ""),
		browser_online: "true",
		cookie_enabled: "true",
		device_id: http.deviceId,
		did: http.deviceId,
		iid: http.installId,
		awemeim_guid: http.guid,
		channel: "0"
	});
	const url = `${DESKTOP_ORIGIN}/aweme/v1/web/user/profile/self/?${params}`;
	const res = await http.requestJson(url, { method: "GET" });
	const user = res.data["user"] ?? {};
	const nickname = typeof user["nickname"] === "string" ? user["nickname"] : undefined;
	const uid = user["uid"] ?? user["user_id_str"] ?? user["user_id"];
	const thumb = user["avatar_thumb"];
	const avatar = Array.isArray(thumb?.url_list) ? thumb.url_list.find((u) => typeof u === "string" && u !== "") : undefined;
	return {
		...uid != null ? { uid: String(uid) } : {},
		...nickname ? { nickname } : {},
		...avatar ? { avatar } : {}
	};
}
/**
* 护照预热（会话恢复用）：get_client_cert（等价参考实现 skipPassportWarmup 第一步）。
* 使服务端 Set-Cookie `bd_ticket_guard_server_data`（设备认证数据，
* Cookie 通道发送内容审核的关键信任凭据）。
* 参考实现的 passport/web/challenge 步骤需按 path 参与签名（signExtrasForPath），
* 我们未复刻该签名，调用会返回 2035 非法请求，故不做。
*/
async function runPassportWarmup(http) {
	await ticketGuardGetClientCert(http);
}
/** POST /passport/ticket_guard/get_client_cert/，服务端下发 bd_ticket_guard_server_data */
async function ticketGuardGetClientCert(http) {
	const query = {
		aid: CREATOR_AID,
		msToken: http.getMsToken() ?? ""
	};
	if (query.msToken) {
		query.a_bogus = generateABogus({
			userAgent: http.getUserAgent(),
			query: new URLSearchParams(query).toString(),
			body: ""
		});
	}
	const search = new URLSearchParams(query).toString();
	await http.requestRaw(passportUrl("/passport/ticket_guard/get_client_cert/", search), {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: encodeFormBody({
			server_data: "1",
			aid: CREATOR_AID
		})
	});
}
/** 桌面端 ttwid 预热（imdesktop 域，对齐 douyin-im ttwidCheck；失败不阻断登录） */
async function desktopTtwidCheck(http) {
	const body = JSON.stringify({
		aid: 339757,
		service: "imdesktop.douyin.com",
		unionHost: "https://ttwid.bytedance.com",
		host: "https://imdesktop.douyin.com",
		union: false,
		needFid: false,
		fid: "",
		migrate_priority: 0
	});
	await http.requestRaw(`${DESKTOP_ORIGIN}/ttwid/check/`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body
	});
}

//#endregion
//#region src/core/auth/device-profile.ts
/**
* 官方桌面设备注册协议（对齐 douyin-im device-registration）：
* 真实硬件标识 → /service/2/desktop/device_register/ 签发数字 device_id/install_id，
* 服务端认识设备后登录不再强制 MFA 二次验证。
*/
const run = promisify(execFile);
const ORIGIN = "https://imdesktop.douyin.com";
const CHANNEL = "local_test";
/** Desktop 系统设备信息 2.0.1 / passport-util logEncrypt v3（替换+轮转，非 AES） */
const SBOX = Buffer.from("637c777bf26b6fc53001672bfed7ab76ca82c97dfa5947f0add4a2af9ca472c0b7fd9326363ff7cc34a5e5f171d8311504c723c31896059a071280e2eb27b27509832c1a1b6e5aa0523bd6b329e32f8453d100ed20fcb15b6acbbe394a4c58cfd0efaafb434d338545f9027f503c9fa851a3408f929d38f5bcb6da2110fff3d2cd0c13ec5f974417c4a77e3d645d197360814fdc222a908846eeb814de5e0bdbe0323a0a4906245cc2d3ac629195e479e7c8376d8dd54ea96c56f4ea657aae08ba78252e1ca6b4c6e8dd741f4bbd8b8a703eb5664803f60e613557b986c11d9ee1f8981169d98e949b1e87e9ce5528df8ca1890dbfe6426841992d0fb054bb16", "hex");
const KEY = Buffer.from("I+D&*76:j27kVH<us9&d").subarray(0, 16).map((b) => SBOX[b]);
function encodeDeviceLog(value, timestamp = Date.now()) {
	const gzip = gzipSync(Buffer.from(value), {
		level: 6,
		memLevel: 4
	});
	gzip.writeUInt32LE(Math.floor(timestamp / 1e3), 4);
	gzip[9] = 3;
	const padding = (16 - gzip.length % 16) % 16;
	const input = Buffer.concat([gzip, Buffer.alloc(padding, padding)]);
	const output = Buffer.alloc(6 + input.length);
	output.set([
		116,
		99,
		3,
		padding,
		0,
		3
	]);
	for (let base = 0; base < input.length; base += 16) {
		for (let word = 0; word < 4; word++) {
			for (let byte = 0; byte < 4; byte++) {
				const index = word * 4 + byte;
				output[6 + base + index] = SBOX[input[base + word * 4 + (byte + word) % 4]] ^ KEY[index];
			}
		}
	}
	return output;
}
/** Desktop 的 Eo(app.getGuid()) 兜底；注册成功后被服务端 DID 替换 */
function guidDeviceId(guid) {
	let hash = 0;
	for (let index = 0; index < guid.length; index++) hash = 31 * hash + guid.charCodeAt(index) >>> 0;
	return String(hash);
}
function randomGuid() {
	return randomUUID().replaceAll("-", "");
}
/** 读取本机硬件标识（Windows WMI，与官方桌面客户端同源字段） */
async function readDesktopHardware() {
	const { stdout } = await run("powershell.exe", [
		"-NoProfile",
		"-NonInteractive",
		"-Command",
		"$s=Get-CimInstance Win32_ComputerSystemProduct; $d=Get-CimInstance Win32_DiskDrive | Where-Object SerialNumber | Select-Object -First 1; @{model=$s.Name;uuid=$s.UUID;serial=$d.SerialNumber} | ConvertTo-Json -Compress"
	], {
		encoding: "utf8",
		timeout: 15e3,
		maxBuffer: 8 * 1024 * 1024,
		windowsHide: true
	});
	const result = JSON.parse(stdout.trim());
	const uuid = result["uuid"]?.trim() ?? "";
	const serial = result["serial"]?.trim() ?? "";
	if (!uuid || !serial) throw new Error("桌面硬件标识不可用");
	const timezone = new Date().toString().split(" ")[5] ?? "";
	return {
		release: os.release(),
		model: result["model"]?.trim() ?? "",
		uuid,
		serial,
		mac: Object.values(os.networkInterfaces()).flat().find((e) => e?.mac && e.mac !== "00:00:00:00:00:00")?.mac ?? "",
		resolution: "1707x1067",
		timezone,
		timezoneName: Intl.DateTimeFormat().resolvedOptions().timeZone,
		timezoneOffset: -new Date().getTimezoneOffset() * 60,
		language: Intl.DateTimeFormat().resolvedOptions().locale
	};
}
function platformParams(hardware) {
	return {
		aid: "339757",
		channel: CHANNEL,
		os: "Windows",
		device_platform: "PC",
		version_code: "1.2.1",
		pc_uuid: hardware.uuid,
		pc_serial: hardware.serial
	};
}
/** 构造 device_register 请求（JSON 整数字段不经 Number 以保留 int64） */
function buildDeviceRegistration(hardware, current) {
	const common = platformParams(hardware);
	const query = new URLSearchParams({
		...common,
		os_version: hardware.release,
		device_type: common["device_platform"]
	});
	const body = {
		header: {
			device_id: 0,
			install_id: 0,
			os: "Windows",
			device_platform: "PC",
			sdk_version: "2.0.1",
			aid: 339757,
			mc: hardware.mac,
			channel: CHANNEL,
			package: "com.bytedance.aweme-im-pc.desktop",
			language: hardware.language,
			app_version: "1.2.1",
			os_version: hardware.release,
			device_model: hardware.model,
			time_zone: hardware.timezone,
			tz_name: hardware.timezoneName,
			tz_offset: hardware.timezoneOffset,
			resolution: hardware.resolution,
			app_region: "cn",
			app_language: "zh-CN",
			display_name: "抖音聊天",
			pc_uuid: hardware.uuid,
			pc_serial: hardware.serial
		},
		_gen_time: 0,
		magic_tag: "ss_app_log"
	};
	const json = JSON.stringify(body).replace("\"device_id\":0", `"device_id":${current?.deviceId ?? "0"}`).replace("\"install_id\":0", `"install_id":${current?.installId ?? "0"}`);
	return {
		url: `${ORIGIN}/service/2/desktop/device_register/?${query}`,
		body: encodeDeviceLog(json)
	};
}
const asDeviceId = (value) => {
	if (typeof value === "string" && /^[1-9]\d*$/.test(value) || typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
		return String(value);
	}
	throw new Error("设备注册返回了无效 ID");
};
/** 注册设备换取服务端 device_id/install_id */
async function registerDesktopDevice(hardware, current) {
	const request = buildDeviceRegistration(hardware, current);
	const response = await fetch(request.url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"User-Agent": "TTNetwork PC"
		},
		body: new Uint8Array(request.body),
		signal: AbortSignal.timeout(3e4)
	});
	if (!response.ok) throw new Error(`设备注册 HTTP ${response.status}`);
	const result = await response.json();
	return {
		deviceId: asDeviceId(result["device_id_str"] ?? result["device_id"]),
		installId: asDeviceId(result["install_id_str"] ?? result["install_id"])
	};
}
/** 激活已注册设备 */
async function activateDesktopDevice(hardware, device) {
	const query = new URLSearchParams({
		...platformParams(hardware),
		app_name: "抖音聊天",
		device_id: device.deviceId,
		iid: device.installId
	});
	const response = await fetch(`${ORIGIN}/service/2/app_alert/?${query}`, {
		method: "POST",
		signal: AbortSignal.timeout(3e4)
	});
	if (!response.ok) throw new Error(`设备激活 HTTP ${response.status}`);
	const result = await response.json();
	if (result["message"] !== "success") throw new Error("设备激活未确认");
}
/**
* 登录前的桌面设备生命周期（对齐 douyin-im startDeviceLifecycle）：
* 已存身份刷新注册；无身份时硬件注册签发 DID；失败回退 GUID 哈希。
* 身份为机器级，落盘 accountsDir/device.json。
*/
async function setupDesktopDevice(deviceFile, http) {
	let saved;
	try {
		saved = JSON.parse(await readFile(deviceFile, "utf8"));
	} catch {}
	const guid = saved?.guid || randomGuid();
	try {
		const hardware = await readDesktopHardware();
		const current = saved?.deviceId && saved?.installId ? {
			deviceId: saved.deviceId,
			installId: saved.installId
		} : undefined;
		const registered = await registerDesktopDevice(hardware, current);
		await activateDesktopDevice(hardware, registered).catch(() => undefined);
		const identity = {
			...registered,
			guid
		};
		await writeFile(deviceFile, JSON.stringify(identity), "utf8");
		http?.setDevice(identity);
		return identity;
	} catch {
		const identity = saved?.deviceId ? saved : {
			deviceId: guidDeviceId(guid),
			installId: "0",
			guid
		};
		http?.setDevice(identity);
		return identity;
	}
}

//#endregion
//#region src/core/sign/source-info.ts
/**
* `account_sdk_source_info`：对 JSON 字符串逐字节 XOR 5，再按 JS `toString(16)` 无补零拼成 hex。
*/
function encodeAccountSdkSourceInfo(plain) {
	let out = "";
	for (const ch of plain) {
		out += ((ch.codePointAt(0) ?? 0) ^ 5).toString(16);
	}
	return out;
}
function decodeAccountSdkSourceInfo(encoded) {
	const chars = [];
	let i = 0;
	while (i < encoded.length) {
		if (i + 2 <= encoded.length) {
			try {
				const b = Number.parseInt(encoded.slice(i, i + 2), 16);
				chars.push(String.fromCodePoint(b ^ 5));
				i += 2;
				continue;
			} catch {}
		}
		const b = Number.parseInt(encoded.slice(i, i + 1), 16);
		chars.push(String.fromCodePoint(b ^ 5));
		i += 1;
	}
	return chars.join("");
}

//#endregion
//#region src/core/sign/browser-info.ts
function encodeBrowserInfo(browserInfo) {
	return encodeAccountSdkSourceInfo(JSON.stringify(browserInfo));
}
/** 与抓包解码后的 browserInfo 结构一致（脱敏模板，无用户 id） */
const DEFAULT_BROWSER_INFO = {
	hardwareConcurrency: 10,
	webdriver: false,
	chromedriver: false,
	shelldriver: false,
	plugins: 5,
	permissions: [{
		name: "notifications",
		state: "prompt"
	}],
	innerHeight: 982,
	innerWidth: 1728,
	outerHeight: 1117,
	outerWidth: 1728,
	stoargeStatus: {
		indexedDB: {
			idb: "object",
			open: "function",
			indexedDB: "object",
			IDBKeyRange: "function",
			openDatabase: "undefined",
			isSafari: false,
			hasFetch: true
		},
		localStorage: {
			isSupportLStorage: true,
			size: 0,
			write: true
		},
		storageQuotaStatus: {
			usage: 0,
			quota: 10737426463,
			isPrivate: false
		}
	},
	webgl: {
		vendor: "Google Inc. (Apple)",
		renderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M5, Unspecified Version)"
	},
	notificationPermission: "default",
	performance: {
		timeOrigin: Date.now(),
		usedJSHeapSize: 5e7,
		navigationTiming: {
			entryType: "navigation",
			initiatorType: "navigation",
			name: "https://creator.douyin.com/creator-micro/home"
		}
	},
	request_host: "creator.douyin.com",
	request_pathname: "/creator-micro/home",
	browser: {
		t: String(Date.now()),
		bit_protocol: "false",
		bit_helper: false
	}
};
/** jumpbyte desktop 登录使用的稳定 Windows/Electron browserInfo */
function desktopLoginBrowserInfo(deviceId) {
	return {
		hardwareConcurrency: 8,
		webdriver: false,
		chromedriver: false,
		shelldriver: false,
		plugins: 5,
		permissions: [{
			name: "notifications",
			state: "granted"
		}],
		innerHeight: 484,
		innerWidth: 726,
		outerHeight: 484,
		outerWidth: 726,
		stoargeStatus: {
			indexedDB: {
				idb: "object",
				open: "function",
				indexedDB: "object",
				IDBKeyRange: "function",
				openDatabase: "function",
				isSafari: false,
				hasFetch: false
			},
			localStorage: {
				isSupportLStorage: true,
				size: 1993,
				write: true
			},
			storageQuotaStatus: {
				usage: 0,
				quota: 36104626176,
				isPrivate: false
			}
		},
		webgl: {
			vendor: "Google Inc. (Google)",
			renderer: "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)"
		},
		notificationPermission: "granted",
		performance: {
			timeOrigin: 1787813991280.3,
			usedJSHeapSize: 182e5,
			navigationTiming: {
				decodedBodySize: 2527,
				entryType: "navigation",
				initiatorType: "navigation",
				name: `file:///renderer/login/index.html?window=login&channel=0&guid=${deviceId}`,
				renderBlockingStatus: "non-blocking"
			}
		},
		request_host: "",
		request_pathname: "/renderer/login/index.html",
		browser: {
			t: "7781993187871",
			bit_protocol: "false",
			bit_helper: false
		}
	};
}

//#endregion
//#region src/core/sign/mix-mode.ts
/**
* Passport `mix_mode=1`：明文 UTF-8 逐字节 XOR 0x05，两位小写 hex 拼接。
*/
function mixModeEncode(plain) {
	const bytes = Buffer.from(plain, "utf8");
	let out = "";
	for (let i = 0; i < bytes.length; i++) {
		out += (bytes[i] ^ 5).toString(16).padStart(2, "0");
	}
	return out;
}
/** 创作者抓包形态：`+86 ` + 11 位手机号（含空格） */
function mixModeEncodeMobile(mobileDigits, countryCode = "86") {
	const digits = mobileDigits.replace(/\D/g, "");
	return mixModeEncode(`+${countryCode} ${digits}`);
}
/** `send_code` 默认短信类型明文 `24` */
const SEND_CODE_TYPE_PLAIN = "24";
function mixModeEncodeSendCodeType(typePlain = "24") {
	return mixModeEncode(typePlain);
}

//#endregion
//#region src/core/auth/passport-lite.ts
/**
* desktop lite Passport 传输层（imdesktop 域 + jumpbyte a_bogus 签名）。
* 供扫码 MFA（qr.ts）与登录安全验证（verification.ts）共用。
*/
const DESKTOP_LITE_AID = "339757";
/** 抖音聊天桌面客户端版本号（对齐 douyin-im 修复发送限速提交 e767ef72 的取值） */
const DESKTOP_APP_VERSION = "1.2.1";
/** 设备 ID 兜底：进程级随机 hex。登录时若已注册桌面设备则优先用注册 DID */
const DESKTOP_LITE_DEVICE_ID = randomDesktopHex(16);
const DESKTOP_LITE_BASE_QUERY = (deviceId) => ({
	passport_jssdk_version: "5.1.2",
	passport_jssdk_type: "lite",
	is_from_ttaccountsdk: "1",
	aid: DESKTOP_LITE_AID,
	language: "zh",
	account_app_language: "zh",
	is_new_login: "1",
	is_from_iesaccountsaas: "1",
	biz_trace_id: randomDesktopHex(8),
	new_authn_sdk_version: "1.0.0.421-web",
	device_id: deviceId ?? DESKTOP_LITE_DEVICE_ID,
	iid: "0",
	version_code: DESKTOP_APP_VERSION,
	device_platform: "PC"
});
/** desktop lite Passport 表单 POST（imdesktop 域 + jumpbyte a_bogus） */
async function desktopLitePassportFormPost(http, path, body) {
	const query = {
		...DESKTOP_LITE_BASE_QUERY(http.hasDesktopDevice() ? http.deviceId : undefined),
		msToken: randomMsToken128()
	};
	const bodyWire = encodeDesktopPassportParams(body);
	const queryWire = encodeDesktopPassportParams(query);
	const aBogus = generateJumpbyteABogus({
		userAgent: http.getUserAgent(),
		query: queryWire,
		body: bodyWire
	});
	const url = `https://imdesktop.douyin.com${path}?${queryWire}&a_bogus=${encodeURIComponent(aBogus)}`;
	const res = await http.requestJson(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Referer: "https://imdesktop.douyin.com"
		},
		body: bodyWire
	});
	if (!res.ok) {
		throw new Error(`${path} failed: HTTP ${res.status} ${res.rawText.slice(0, 200)}`);
	}
	return res.data;
}

//#endregion
//#region src/core/auth/verification.ts
/**
* 登录安全验证（验证中心决策）本地浏览器验证页。
*
* 逆向自 douyin-im e767ef72（修复发送限速）：Passport 登录响应（check_qrconnect 等）
* 可能下发 verify_center_decision_conf / verify_center_secondary_decision_conf，
* 要求先完成官方安全验证（滑块/短信/扫码等）才能获得可信登录态 ——
* 登录态可信度不足是发送消息被会话级降权（7523）的根因。
*
* 本模块启动本地 HTTP 验证页承载官方验证组件（Second Verify 1.0.29 / captcha SDK），
* 验证完成后把结果字段回填原请求重试。
*/
const require = createRequire(import.meta.url);
/** 官方验证码 SDK（验证中心）及备用地址 */
const VERIFY_CENTER_SDK = "https://lf-rc1.yhgfb-cn-static.com/obj/rc-verifycenter/verifycenter/@latest/index.js";
const VERIFY_CENTER_SDK_BACKUPS = ["https://lf-rc2.yhgfb-cn-static.com/obj/rc-verifycenter/verifycenter/@latest/index.js", "https://lf-cdn-tos.bytescm.com/obj/rc-verifycenter/verifycenter/@latest/index.js"];
/** 验证页代理允许访问的主机 */
const VERIFICATION_HOSTS = new Set([
	"imdesktop.douyin.com",
	"verify.zijieapi.com",
	"vcs.zijieapi.com"
]);
/**
* 从登录响应中解析验证中心决策；无决策返回 undefined。
* 检测顺序对齐参考实现：主决策 > 二次决策；无 conf 时按
* error_code=1105 或 captcha 字段兜底为滑块验证。
*/
function parseVerificationDecision(data) {
	const source = data;
	const nested = asRecord$2(source["data"]);
	const candidates = [
		[nested?.["verify_center_decision_conf"], false],
		[nested?.["verify_center_secondary_decision_conf"], true],
		[source["verify_center_decision_conf"], false],
		[source["verify_center_secondary_decision_conf"], true]
	];
	const selected = candidates.find(([value]) => value != null && value !== "");
	const rawValue = selected?.[0];
	const secondary = selected?.[1] === true;
	const record = asRecord$2(rawValue);
	if (record) {
		return {
			raw: JSON.stringify(record),
			decision: {
				...record,
				...secondary ? { verification_level: "secondary" } : {}
			},
			secondary
		};
	}
	if (typeof rawValue === "string" && rawValue.length > 0) {
		return {
			raw: rawValue,
			decision: {
				...parseDecisionConf(rawValue),
				...secondary ? { verification_level: "secondary" } : {}
			},
			secondary
		};
	}
	const errorCode = Number(source["error_code"] ?? 0);
	const captchaValue = source["captcha"];
	const hasCaptcha = captchaValue != null && captchaValue !== "";
	if (errorCode !== 1105 && !hasCaptcha) return undefined;
	const fallback = {
		verify_from: "captcha",
		...hasCaptcha ? { captcha: captchaValue } : {},
		...source["verify_ticket"] != null ? { verify_ticket: source["verify_ticket"] } : {}
	};
	return {
		raw: JSON.stringify(fallback),
		decision: fallback,
		secondary: false
	};
}
/** 打开本地验证页并等待用户完成官方安全验证 */
async function runBrowserVerification(http, descriptor, hooks = {}) {
	const timeoutMs = hooks.timeoutMs ?? 3e5;
	const react = await readFile(resolveReactAsset("react", "react.production.min.js"));
	const reactDom = await readFile(resolveReactAsset("react-dom", "react-dom.production.min.js"));
	const prepared = await prepareVerification(http, descriptor);
	return new Promise((resolve, reject) => {
		let finished = false;
		const sessionToken = randomUUID();
		const finish = (error, outcome) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			server.close(() => error ? reject(error) : resolve(outcome ?? { fields: {} }));
		};
		const server = createServer((request, response) => {
			void handleRequest(request, response, {
				http,
				prepared,
				react,
				reactDom,
				sessionToken,
				finish
			}).catch((error) => {
				sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
			});
		});
		server.once("error", (error) => finish(error));
		const timer = setTimeout(() => finish(new Error("登录验证超时")), timeoutMs);
		timer.unref();
		server.listen(0, "0.0.0.0", () => {
			const address = server.address();
			if (typeof address !== "object" || address === null) {
				finish(new Error("无法取得登录验证页地址"));
				return;
			}
			const url = `http://127.0.0.1:${address.port}/?token=${encodeURIComponent(sessionToken)}`;
			logger.info(`[douyin] 登录安全验证页: ${url}`);
			hooks.onUrl?.(url);
		});
	});
}
/** 组装验证组件启动配置：verify_center 决策需先换取动态验证脚本配置 */
async function prepareVerification(http, descriptor) {
	const deviceId = http.hasDesktopDevice() ? http.deviceId : randomDesktopHex(16);
	let config = { ...descriptor.decision };
	const verifyFrom = String(config["verify_from"] ?? "");
	const verifyCenter = [
		1e4,
		2e4,
		3e4,
		4e4
	].includes(Number(config["code"]));
	if (!verifyCenter && verifyFrom === "verify_center") {
		config = {
			...config,
			...await packVerifyWaysData(http, config, deviceId)
		};
	}
	const fp = `verify_${deviceId}`;
	const rawUrl = typeof config["url"] === "string" ? config["url"] : undefined;
	if (verifyCenter) {
		const setting = await loadVerifyCenterSetting(http, deviceId);
		const configuredPrimary = asRecord$2(setting?.["js_v2"])?.["cn"];
		const configuredBackups = asRecord$2(setting?.["back_up_js_v2"])?.["cn"];
		const urls = [
			...typeof configuredPrimary === "string" ? [configuredPrimary] : [],
			...Array.isArray(configuredBackups) ? configuredBackups.filter((value) => typeof value === "string") : [],
			VERIFY_CENTER_SDK,
			...VERIFY_CENTER_SDK_BACKUPS
		];
		if (setting) config["scene_level"] = setting["scene_level"] ?? "p2";
		return {
			mode: "verify-center",
			config,
			fp,
			deviceId,
			captchaScriptUrls: [...new Set(urls)]
		};
	}
	if (!rawUrl) {
		throw new Error("平台未下发登录验证脚本 URL");
	}
	const script = new URL(rawUrl);
	if (script.protocol !== "https:") {
		throw new Error(`平台下发了不安全的登录验证脚本: ${script.protocol}`);
	}
	script.searchParams.set("aid", DESKTOP_LITE_AID);
	const eventParams = asRecord$2(config["event_params"]);
	script.searchParams.set("verify_reason", String(eventParams?.["verify_reason"] ?? ""));
	script.searchParams.set("verify_scene", String(eventParams?.["verify_scene"] ?? ""));
	return {
		mode: "second-verify",
		config,
		fp,
		deviceId,
		scriptUrl: script.toString()
	};
}
/**
* Desktop Second Verify 1.0.29：将 verify-center 决策换成动态验证脚本配置。
* POST /passport/safe/pack_verify_ways_data/，字段 encodePassportField 编码，
* 跳过 is_login / null。
*/
async function packVerifyWaysData(http, decision, deviceId) {
	const body = {};
	const requestData = {
		aid: Number(DESKTOP_LITE_AID),
		...decision,
		device_id: deviceId,
		iid: "0",
		version_code: DESKTOP_APP_VERSION,
		device_platform: "PC"
	};
	for (const [key, value] of Object.entries(requestData)) {
		if (key === "is_login" || value == null) continue;
		body[key] = encodePassportField(value);
	}
	const res = await desktopLitePassportFormPost(http, "/passport/safe/pack_verify_ways_data/", body);
	if (res.data.error_code != null && res.data.error_code !== 0) {
		throw new Error(`pack_verify_ways_data failed: code=${res.data.error_code} ${String(res.data.description ?? "")}`);
	}
	return res.data;
}
/** 验证码 SDK 配置（含 scene_level 与 js_v2 脚本地址）；失败不阻断，走内置 SDK 地址 */
async function loadVerifyCenterSetting(http, deviceId) {
	try {
		const query = new URLSearchParams({
			aid: DESKTOP_LITE_AID,
			did: deviceId || "0",
			iid: "0"
		});
		const res = await requestVerificationRaw(http, `https://vcs.zijieapi.com/vc/setting?${query}`, {
			method: "GET",
			headers: { "X-Setting-Flag": "1" }
		});
		if (!res.ok) return undefined;
		const parsed = asRecord$2(tryParseJson(res.rawText));
		const data = asRecord$2(parsed?.["data"]) ?? parsed;
		return asRecord$2(data?.["verify"]);
	} catch {
		return undefined;
	}
}
/**
* 验证组件专用请求：imdesktop 域带账号 Cookie + Passport 头；
* 验证中心域（zijieapi）不带 Cookie，避免混入登录态。
*/
async function requestVerificationRaw(http, url, init) {
	if (new URL(url).origin === "https://imdesktop.douyin.com") {
		const res = await http.requestRaw(url, {
			...init,
			headers: {
				...http.passportHeaders(url),
				...init.headers
			}
		});
		return {
			ok: res.ok,
			status: res.status,
			headers: res.headers,
			rawText: res.rawText
		};
	}
	const res = await fetch(url, {
		...init,
		headers: {
			"User-Agent": http.getUserAgent(),
			...init.headers
		},
		signal: AbortSignal.timeout(3e4)
	});
	return {
		ok: res.ok,
		status: res.status,
		headers: res.headers,
		rawText: await res.text()
	};
}
async function handleRequest(request, response, state) {
	const url = new URL(request.url ?? "/", "http://127.0.0.1");
	if (url.searchParams.get("token") !== state.sessionToken) {
		sendJson(response, 403, { error: "登录验证会话无效" });
		return;
	}
	if (request.method === "GET" && url.pathname === "/") {
		sendHtml(response, platformVerificationHtml(state.prepared, state.sessionToken));
		return;
	}
	if (request.method === "GET" && url.pathname === "/react.js") {
		sendScript(response, state.react);
		return;
	}
	if (request.method === "GET" && url.pathname === "/react-dom.js") {
		sendScript(response, state.reactDom);
		return;
	}
	if (request.method === "POST" && url.pathname === "/api/request") {
		const payload = await readJsonBody(request);
		const target = resolveVerificationUrl(payload["url"], payload["baseURL"]);
		assertVerificationHost(target);
		const method = String(payload["method"] ?? "GET").toUpperCase();
		if (![
			"GET",
			"POST",
			"PUT",
			"PATCH",
			"DELETE",
			"HEAD",
			"OPTIONS"
		].includes(method)) {
			throw new Error(`登录验证不支持请求方法: ${method}`);
		}
		const headers = sanitizeProxyHeaders(asStringRecord(payload["headers"]));
		const body = typeof payload["body"] === "string" ? payload["body"] : undefined;
		const result = await requestVerificationRaw(state.http, target.toString(), {
			method,
			headers,
			...body !== undefined && method !== "GET" && method !== "HEAD" ? { body } : {}
		});
		sendJson(response, 200, {
			data: tryParseJson(result.rawText),
			rawText: result.rawText,
			status: result.status,
			statusText: result.ok ? "OK" : "ERROR",
			headers: Object.fromEntries([...result.headers.entries()].filter(([key]) => key.toLowerCase() !== "set-cookie"))
		});
		return;
	}
	if (request.method === "POST" && url.pathname === "/api/complete") {
		const payload = await readJsonBody(request);
		const resultValue = asRecord$2(payload["result"]);
		const fields = asRecord$2(resultValue?.["fields"] ?? resultValue) ?? {};
		const fp = String(resultValue?.["fp"] ?? "") || state.prepared.fp;
		sendJson(response, 200, { ok: true });
		state.finish(undefined, {
			fp,
			fields
		});
		return;
	}
	if (request.method === "POST" && url.pathname === "/api/cancel") {
		sendJson(response, 200, { ok: true });
		state.finish(new Error("用户关闭了登录验证"));
		return;
	}
	response.writeHead(404);
	response.end("Not Found");
}
function platformVerificationHtml(prepared, sessionToken) {
	const boot = safeJson({
		mode: prepared.mode,
		config: prepared.config,
		fp: prepared.fp,
		scriptUrl: prepared.scriptUrl,
		sessionToken,
		deviceId: prepared.deviceId,
		captchaScriptUrls: prepared.captchaScriptUrls
	});
	return pageShell("抖音登录安全验证", `
    <div id="app"><div class="loading">正在加载抖音安全验证…</div></div>
    <script src="/react.js?token=${encodeURIComponent(sessionToken)}"><\/script>
    <script src="/react-dom.js?token=${encodeURIComponent(sessionToken)}"><\/script>
    <script>window.__LOGIN_VERIFY__=${boot};<\/script>
    <script>${browserBridgeScript()}<\/script>
    <script>window.startDouyinVerification();<\/script>
  `);
}
/** 页面与官方验证组件之间的桥接脚本：代理请求 + 注入环境 + 启动验证 */
function browserBridgeScript() {
	return String.raw`
    (() => {
      const boot = window.__LOGIN_VERIFY__;
      localStorage.setItem('s_v_web_id', boot.fp);
      document.cookie = 's_v_web_id=' + encodeURIComponent(boot.fp) + '; path=/';
      const complete = async (result = {}) => {
        const response = await fetch('/api/complete?token=' + encodeURIComponent(boot.sessionToken), {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({result})});
        const data = await response.json();
        if (!response.ok || data.error) throw new Error(data.error || '恢复登录失败');
        document.getElementById('app').innerHTML = '<main class="card"><h1>验证通过</h1><p>正在继续登录，可以关闭此页。</p></main>';
      };
      const proxy = async (config = {}) => {
        const encode = (value) => value instanceof Date ? value.toISOString() : value && typeof value === 'object' ? JSON.stringify(value) : String(value);
        const params = new URLSearchParams();
        Object.entries(config.params || {}).forEach(([key, value]) => {
          if (value == null) return;
          if (Array.isArray(value)) value.forEach(item => params.append(key + '[]', encode(item)));
          else params.append(key, encode(value));
        });
        let url = config.url || '';
        if (params.size) url += (url.includes('?') ? '&' : '?') + params;
        let body = config.data;
        const headers = {...(config.headers || {})};
        const contentTypeKey = Object.keys(headers).find(key => key.toLowerCase() === 'content-type');
        const contentType = contentTypeKey ? String(headers[contentTypeKey]).toLowerCase() : '';
        if (body instanceof FormData) {
          const form = new URLSearchParams();
          for (const [key, value] of body.entries()) form.append(key, encode(value));
          body = form.toString();
          headers[contentTypeKey || 'Content-Type'] = 'application/x-www-form-urlencoded';
        } else if (body && typeof body === 'object') {
          if (contentType.includes('application/json')) body = JSON.stringify(body);
          else {
            const form = new URLSearchParams();
            Object.entries(body).forEach(([key, value]) => {
              if (value == null) return;
              if (Array.isArray(value)) value.forEach(item => form.append(key + '[]', encode(item)));
              else form.append(key, encode(value));
            });
            body = form.toString();
            headers[contentTypeKey || 'Content-Type'] = 'application/x-www-form-urlencoded';
          }
        }
        const response = await fetch('/api/request?token=' + encodeURIComponent(boot.sessionToken), {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url,baseURL:config.baseURL,method:config.method || 'GET',headers,body})});
        const result = await response.json();
        if (!response.ok || result.error) throw result;
        const axiosResponse = {data: result.data, status: result.status, statusText: result.statusText, headers: result.headers, config};
        if (result.status < 200 || result.status >= 300) {
          const error = new Error('Request failed with status code ' + result.status);
          error.response = axiosResponse;
          error.config = config;
          throw error;
        }
        return axiosResponse;
      };
      window.$$UCALL_APIMAP = window.$$UCALL_APIMAP || {};
      window.$$UCALL_APIMAP['Request.fetch'] = proxy;
      window.$$UCALL_APIMAP['Request.fetchSec'] = proxy;
      window.$$UCALL_APIMAP.Request = proxy;
      window.$$UC_CORE_ENV = {env:'online',container:'web',region:'CN'};
      window.$$UC_ENV_PROMISE = Promise.resolve(window.$$UC_CORE_ENV);
      window.$$UCALL_APIMAP.getEnv = () => window.$$UC_ENV_PROMISE;
      window.$$UCALL_APIMAP.getQuery = () => Object.fromEntries(new URLSearchParams(location.search));
      window.$$UCALL_APIMAP.getSettings = (params) => proxy({url:'/service/settings/v3/',params});
      window.ucSecondVerifyReact = window.React;
      window.ucSecondVerifyReactDom = window.ReactDOM;
      const loadScript = (urls) => new Promise((resolve, reject) => {
        const remaining = [...urls];
        const next = () => {
          const url = remaining.shift();
          if (!url) return reject(new Error('抖音验证 SDK 加载失败'));
          const script = document.createElement('script');
          script.crossOrigin = 'anonymous';
          script.src = url;
          script.onload = resolve;
          script.onerror = next;
          document.head.appendChild(script);
        };
        next();
      });
      window.startDouyinVerification = async () => {
        const common = {aid:339757,did:boot.deviceId || '0',iid:String(boot.config.iid || '0'),...(boot.config.scene_level ? {scene_level:boot.config.scene_level} : {})};
        if (boot.mode === 'verify-center') {
          await loadScript(boot.captchaScriptUrls || []);
          const sdk = window.verifySDK;
          if (!sdk) throw new Error('抖音验证码 SDK 加载失败');
          sdk.initVerifyOptions({commonOptions:common,captchaOptions:{fp:boot.fp,app_name:'抖音聊天',lang:'zh',showMode:'mask',region:'cn',baseEM:70}});
          const success = () => complete({fp: (sdk.getCaptchaWebId && sdk.getCaptchaWebId()) || boot.fp});
          const close = () => fetch('/api/cancel?token=' + encodeURIComponent(boot.sessionToken),{method:'POST'});
          sdk.autoRender({verify_data:boot.config,captchaOptions:{successCb:success,closeCb:close,errorCb:()=>{}},secondVerifyWebOptions:{callBack:success,closeCallBack:close}});
          return;
        }
        await loadScript([boot.scriptUrl]);
        if (typeof window.ucWebSecondVerify !== 'function') throw new Error('抖音二次验证 SDK 加载失败');
        const callback = () => complete({});
        const generalParams = {is_new_login:'1',is_from_iesaccountsaas:1};
        const getGeneralParams = async () => ({device_id:common.did,iid:common.iid,version_code:${JSON.stringify(DESKTOP_APP_VERSION)},device_platform:'PC'});
        const monitorTime = {startTime:Date.now(),fetchEndTime:Date.now(),scriptLoadStartTime:0,scriptLoadEndTime:Date.now(),renderStartTime:Date.now()};
        window.$$account_verify_portrait_id = boot.config.verify_portrait_id || '';
        window.ucWebSecondVerify({...boot.config,aid:339757,appName:'抖音聊天',did:common.did,iid:common.iid,host:'https://imdesktop.douyin.com',newSecondVerifyRequestHost:'https://imdesktop.douyin.com',region:'cn',hcSwitch:false,isOversea:false,ztsdk:false,ztsdkOptions:{agid:1,enableCookieOptions:false},ssoZtsdkOptions:{enable:false},captchaOptions:{fp:boot.fp,baseEM:70},commonOptions:common,generalParams,getGeneralParams,monitorTime,uc_account_verify_version:'1.0.29',fun:boot.config.verify_from === 'verify_center' ? 'verify_center' : 'verify',Request:proxy,request:proxy,verifyFinishCallback:callback,callBack:callback,closeCallBack:()=>fetch('/api/cancel?token=' + encodeURIComponent(boot.sessionToken),{method:'POST'})});
      };
    })();
  `;
}
function pageShell(title, body) {
	return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>
    *{box-sizing:border-box}body{margin:0;min-height:100vh;background:#f5f5f5;color:#161823;font-family:system-ui,-apple-system,sans-serif;display:grid;place-items:center}.card{width:min(420px,calc(100vw - 32px));background:white;border-radius:16px;padding:28px;box-shadow:0 12px 48px #0001}.card h1{font-size:22px;margin:0 0 12px}.card p,.loading{color:#666}#app{min-width:min(420px,calc(100vw - 32px))}
  </style></head><body>${body}</body></html>`;
}
function resolveReactAsset(packageName, file) {
	const packagePath = require.resolve(`${packageName}/package.json`);
	return fileURLToPath(new URL(`./umd/${file}`, `file://${packagePath}`));
}
function resolveVerificationUrl(urlValue, baseValue) {
	const url = String(urlValue ?? "");
	const base = String(baseValue ?? "https://imdesktop.douyin.com");
	return new URL(url, base);
}
function assertVerificationHost(url) {
	const host = url.hostname.toLowerCase();
	if (VERIFICATION_HOSTS.has(host)) return;
	throw new Error(`登录验证拒绝访问未知主机: ${host}`);
}
function sanitizeProxyHeaders(headers) {
	const blocked = new Set([
		"connection",
		"content-length",
		"cookie",
		"host",
		"origin",
		"proxy-authorization",
		"referer",
		"set-cookie",
		"transfer-encoding"
	]);
	return Object.fromEntries(Object.entries(headers).filter(([key]) => !blocked.has(key.toLowerCase())));
}
async function readJsonBody(request) {
	const chunks = [];
	let length = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		length += buffer.length;
		if (length > 1048576) throw new Error("登录验证请求过大");
		chunks.push(buffer);
	}
	const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("登录验证请求格式错误");
	}
	return parsed;
}
function sendJson(response, status, data) {
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store"
	});
	response.end(JSON.stringify(data));
}
function sendHtml(response, html) {
	response.writeHead(200, {
		"content-type": "text/html; charset=utf-8",
		"cache-control": "no-store",
		"referrer-policy": "no-referrer"
	});
	response.end(html);
}
function sendScript(response, script) {
	response.writeHead(200, {
		"content-type": "text/javascript; charset=utf-8",
		"cache-control": "public, max-age=3600"
	});
	response.end(script);
}
function safeJson(value) {
	return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
function escapeHtml(value) {
	return value.replace(/[&<>"']/g, (char) => ({
		"&": "&amp;",
		"<": "&lt;",
		">": "&gt;",
		"\"": "&quot;",
		"'": "&#39;"
	})[char]);
}
/** Passport 字段编码：字符串原样，数字/布尔转字符串，对象 JSON 序列化 */
function encodePassportField(value) {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return JSON.stringify(value);
}
/** 验证结果字段回填 check_qrconnect body 时统一转为字符串 */
function stringifyVerificationFields(fields) {
	return Object.fromEntries(Object.entries(fields).filter(([, value]) => value != null).map(([key, value]) => [key, encodePassportField(value)]));
}
function parseDecisionConf(value) {
	try {
		const parsed = JSON.parse(value);
		return asRecord$2(parsed) ?? { verify_data: parsed };
	} catch {
		return { verify_data: value };
	}
}
function asRecord$2(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}
function asStringRecord(value) {
	const record = asRecord$2(value);
	if (!record) return {};
	return Object.fromEntries(Object.entries(record).filter(([, item]) => item != null).map(([key, item]) => [key, String(item)]));
}
function tryParseJson(value) {
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

//#endregion
//#region src/core/auth/qr.ts
const QR_POLL_INTERVAL_MS = 1100;
const QR_DEFAULT_BODY = {
	need_logo: "false",
	need_short_url: "false",
	is_frontier: "true",
	is_new_login: "1",
	next: "https://www.douyin.com"
};
/** GET /passport/web/get_qrcode/（imdesktop 桌面客户端流程），返回二维码 token 与 base64 图片 */
async function getQrcode(http) {
	const baseQuery = buildDesktopPassportBaseQuery({
		deviceId: http.deviceId,
		installId: http.installId,
		accountSdkSourceInfo: resolveAccountSdkSourceInfo(http),
		bizTraceId: http.bizTraceId,
		next: QR_DEFAULT_BODY.next,
		extra: {
			need_logo: "false",
			need_short_url: "false"
		}
	});
	const { search } = signPassportQuery(baseQuery, {}, signExtras(http));
	const url = desktopPassportUrl("/passport/web/get_qrcode/", search);
	const res = await http.requestJson(url, {
		method: "GET",
		headers: http.passportHeaders(url)
	});
	if (!res.ok) {
		throw new Error(`get_qrcode failed: HTTP ${res.status} ${res.rawText.slice(0, 200)}`);
	}
	const d = res.data.data;
	if (d.error_code !== 0 || !d.qrcode) {
		throw new Error(`get_qrcode error_code=${d.error_code}`);
	}
	const info = {
		token: d.token,
		qrcodeBase64: d.qrcode,
		expireTime: d.expire_time
	};
	if (d.qrcode_index_url) info.qrcodeIndexUrl = d.qrcode_index_url;
	return info;
}
/** POST /passport/web/check_qrconnect/（imdesktop 域），返回当前扫码状态；options.fp 用于安全验证后回填 */
async function checkQrconnect(http, token, bodyOverrides, options) {
	const body = {
		...QR_DEFAULT_BODY,
		token,
		...bodyOverrides
	};
	const baseQuery = buildDesktopPassportBaseQuery({
		deviceId: http.deviceId,
		installId: http.installId,
		accountSdkSourceInfo: resolveAccountSdkSourceInfo(http),
		bizTraceId: http.bizTraceId,
		extra: options?.fp ? { fp: options.fp } : undefined
	});
	const bodyWire = encodeFormBody(body);
	const { search } = signPassportQuery(baseQuery, body, signExtras(http, bodyWire));
	const url = desktopPassportUrl("/passport/web/check_qrconnect/", search);
	const res = await http.requestJson(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			...http.passportHeaders(url)
		},
		body: bodyWire
	});
	if (!res.ok) {
		throw new Error(`check_qrconnect failed: HTTP ${res.status} ${res.rawText.slice(0, 200)}`);
	}
	return res.data.data;
}
/** 扫码登录：取码 → 轮询直至 confirmed / expired / 超时 */
async function loginByQrcode(http, options = {}) {
	const qr = await getQrcode(http);
	return pollQrConfirm(http, qr.token, options);
}
/** 已取码后的轮询：处理扫码状态与短信二次验证，直至 confirmed/expired/超时 */
async function pollQrConfirm(http, token, options = {}) {
	const pollMs = options.pollIntervalMs ?? 1100;
	const timeoutMs = options.timeoutMs ?? 12e4;
	let deadline = Date.now() + timeoutMs;
	let last;
	let mfaDone = false;
	let notifiedStatus;
	let extraBody = {};
	let verifyCount = 0;
	let fp;
	while (Date.now() < deadline) {
		try {
			last = await checkQrconnect(http, token, extraBody, fp ? { fp } : undefined);
		} catch {
			await sleep$1(pollMs);
			continue;
		}
		const decision = verifyCount < 3 ? parseVerificationDecision(last) : undefined;
		if (decision) {
			verifyCount += 1;
			options.onStatus?.("verifying");
			const outcome = await runBrowserVerification(http, decision, { onUrl: options.onVerifyUrl });
			extraBody = {
				...extraBody,
				...stringifyVerificationFields(outcome.fields)
			};
			fp = outcome.fp ?? fp;
			options.onStatus?.("verified");
			deadline = Date.now() + timeoutMs;
			continue;
		}
		if (!mfaDone && (last.account_flow === "verify" || last.biz_params != null)) {
			options.onStatus?.("verifying");
			const challenge = {
				encrypt_uid: last.encrypt_uid,
				biz_params: last.biz_params,
				common_params: last.common_params
			};
			const way = selectVerifyWay(last);
			if (!way?.verify_way) {
				const list = (last.verify_ways ?? []).map((w) => w.verify_way).filter(Boolean).join(", ");
				throw new Error(`无可支持的验证方式（服务端可选：${list || "无"}）；请在抖音 App 完成该次身份验证后重试`);
			}
			if (way.verify_way === "assist_mobile_up_sms_verify") {
				await upSmsMfaFlow(http, challenge, way, options.onStatus);
			} else if (way.verify_way === "pwd_verify") {
				if (!options.onMfa) {
					throw new Error("登录触发密码二次验证，但未提供 onMfa 回调");
				}
				const password = await options.onMfa({ kind: "password" });
				if (!password) throw new Error("密码二次验证未收到输入");
				const validated = await validateQrPassword(http, challenge, password);
				if (!validated.data.ticket) {
					throw new Error(`扫码密码验证失败: ${validated.data.error_code ?? "-"} ${validated.data.description ?? validated.message ?? ""}`);
				}
				options.onStatus?.("密码验证通过");
			} else {
				if (!options.onMfa) {
					throw new Error("登录触发短信二次验证，但未提供 onMfa 回调");
				}
				const tryWays = way.verify_way === "mobile_sms_verify" ? [way.verify_way, "assist_mobile_sms_verify"] : [way.verify_way];
				let sent;
				let usedWay;
				for (const candidate of tryWays) {
					const res = await sendQrMfaCode(http, challenge, candidate);
					if (res.message === "success") {
						sent = res;
						usedWay = candidate;
						break;
					}
					sent = res;
				}
				if (!sent?.message || sent.message !== "success" || !usedWay) {
					const up = (last.verify_ways ?? []).find((w) => w.verify_way === "assist_mobile_up_sms_verify");
					if (up?.verify_way) {
						options.onStatus?.(`发码被拒（${sent?.message ?? "unknown"}${sent?.data.description ? `: ${sent.data.description}` : ""}），改用上行短信验证`);
						await upSmsMfaFlow(http, challenge, up, options.onStatus);
					} else {
						throw new Error(`发送短信验证码失败: ${sent?.message ?? "unknown"}${sent?.data.description ? ` - ${sent.data.description}` : ""}`);
					}
				} else {
					if (usedWay !== way.verify_way) {
						options.onStatus?.("已改用辅助手机接收验证码");
					}
					const maskedMobile = sent.data.mobile ?? way.mobile;
					const code = await options.onMfa({ maskedMobile: maskedMobile != null ? String(maskedMobile) : undefined });
					const validated = await validateQrMfaCode(http, challenge, usedWay, code);
					if (!validated.data.ticket) {
						throw new Error(`扫码短信验证失败: ${validated.data.error_code ?? "-"} ${validated.data.description ?? validated.message ?? ""}`);
					}
					options.onStatus?.("verified");
				}
			}
			extraBody = pickQrBizParams(last.biz_params);
			mfaDone = true;
			continue;
		}
		const status = last.status;
		if (status && status !== notifiedStatus) {
			notifiedStatus = status;
			options.onStatus?.(status);
		}
		if (status === "confirmed") {
			return sessionFromConfirmed(http, token, last.user_data);
		}
		if (status === "expired") {
			throw new Error("QR code expired");
		}
		await sleep$1(pollMs);
	}
	throw new Error(`QR login timeout after ${timeoutMs}ms; last=${last?.status ?? "none"}`);
}
/** 验证方式优先级：安全手机短信 > 绑定手机短信 > 上行短信（用安全手机发短信）> 登录密码 */
const VERIFY_WAY_PRIORITY = [
	"assist_mobile_sms_verify",
	"mobile_sms_verify",
	"assist_mobile_up_sms_verify",
	"pwd_verify"
];
/** 从 check_qrconnect 响应里按优先级挑选可用的验证方式 */
function selectVerifyWay(data) {
	const ways = data.verify_ways ?? [];
	return VERIFY_WAY_PRIORITY.map((name) => ways.find((way) => way.verify_way === name)).find(Boolean);
}
/** 上行短信验证：用安全手机编辑指定短信发送到服务端号码，然后轮询 validate_code 等确认 */
async function upSmsMfaFlow(http, challenge, way, onStatus) {
	const content = way.sms_content || "YZ";
	onStatus?.(`请用安全手机（${way.mobile ?? ""}）编辑短信"${content}"发送到 ${way.channel_mobile ?? ""}`);
	const deadline = Date.now() + 18e4;
	let last;
	while (Date.now() < deadline) {
		await sleep$1(3e3);
		try {
			last = await validateQrMfaCode(http, challenge, way.verify_way ?? "assist_mobile_up_sms_verify");
		} catch {
			continue;
		}
		if (last.data.ticket) {
			onStatus?.("短信验证通过");
			return;
		}
	}
	throw new Error(`上行短信验证超时: ${last?.data.error_code ?? "-"} ${last?.data.description ?? ""}`);
}
/** 扫码登录触发短信 MFA：发送验证码（jumpbyte desktop lite Passport 流程） */
async function sendQrMfaCode(http, challenge, verifyWay) {
	return desktopLitePassportFormPost(http, "/passport/web/send_code/", qrMfaBody(challenge, verifyWay, { is6Digits: "1" }));
}
/** 校验扫码登录 MFA 短信验证码（上行短信流程不传 code） */
async function validateQrMfaCode(http, challenge, verifyWay, code) {
	const encoded = code == null ? undefined : verifyWay === "mobile_sms_verify" ? mixModeEncode(code) : codeEncrypt(code);
	return desktopLitePassportFormPost(http, "/passport/web/validate_code/", qrMfaBody(challenge, verifyWay, encoded != null ? { code: encoded } : {}));
}
/**
* 登录密码二次验证（pwd_verify，逆向自 second-verification-web.js）：
* POST /passport/web/account/verify/，password 字段 codeEncrypt（Xor5+hex）编码 + mix_mode=1，
* 无 type/send_code 步骤，成功返回 data.ticket。
*/
async function validateQrPassword(http, challenge, password) {
	return desktopLitePassportFormPost(http, "/passport/web/account/verify/", qrMfaBody(challenge, "pwd_verify", { password: codeEncrypt(password) }));
}
/** code_encrypt：UTF-8 每字节 ^5 后的两位 hex（363c 场景配套） */
function codeEncrypt(s) {
	const hex = "0123456789abcdef";
	let out = "";
	for (const ch of s) {
		const c = ch.codePointAt(0) ?? 0;
		const bytes = c <= 127 ? [c] : c <= 2047 ? [192 | c >> 6 & 31, 128 | c & 63] : c <= 65535 ? [
			224 | c >> 12 & 15,
			128 | c >> 6 & 63,
			128 | c & 63
		] : [];
		for (const b of bytes) out += hex[(b ^ 5) >> 4] + hex[(b ^ 5) & 15];
	}
	return out;
}
function qrMfaBody(challenge, verifyWay, extra) {
	const biz = challenge.biz_params ?? {};
	const common = challenge.common_params ?? {};
	const value = (source, key, fallback = "") => {
		const candidate = source[key];
		return candidate == null || candidate === "" ? fallback : String(candidate);
	};
	return {
		mix_mode: "1",
		...verifyWay === "pwd_verify" ? {} : { type: verifyWay === "mobile_sms_verify" ? "3737" : "363c" },
		encrypt_uid: challenge.encrypt_uid ?? "",
		verify_ticket: "",
		copywriting_key: value(common, "copywriting_key", "qr_connect"),
		ies_safety_diversion_tag: value(common, "ies_safety_diversion_tag", "mfa"),
		new_verify_flow: value(common, "new_verify_flow"),
		std_verify_flow_id: value(biz, "std_verify_flow_id", value(common, "std_verify_flow_id")),
		std_verify_scene: value(biz, "std_verify_scene", "account_login"),
		std_verify_template: value(biz, "std_verify_template", "ato"),
		std_verify_token: value(biz, "std_verify_token", value(common, "std_verify_token")),
		std_verify_type: value(biz, "std_verify_type", "MFA"),
		std_verify_way: verifyWay,
		...extra,
		aid: DESKTOP_LITE_AID,
		new_authn_sdk_version: "1.0.0.421-web"
	};
}
const QR_BIZ_PARAM_KEYS = [
	"passport_mfa_retry_tag",
	"std_verify_flow_id",
	"std_verify_scene",
	"std_verify_template",
	"std_verify_token",
	"std_verify_type",
	"std_verify_way"
];
/** MFA 校验通过后，轮询 check_qrconnect 需要携带的 biz 参数 */
function pickQrBizParams(params) {
	const result = {};
	if (!params) return result;
	for (const key of QR_BIZ_PARAM_KEYS) {
		const value = params[key];
		if (value != null) result[key] = String(value);
	}
	return result;
}
function sessionFromConfirmed(http, qrToken, userData) {
	const platformUid = userData?.user_id_str ?? (userData?.user_id != null ? String(userData.user_id) : undefined) ?? http.jar.get("uid_tt");
	if (!platformUid) {
		throw new Error("confirmed but no platformUid (uid_tt cookie or user_data.user_id_str)");
	}
	const session = {
		platformUid,
		cookies: http.getCookies(),
		qrToken
	};
	if (userData) session.userData = userData;
	return session;
}
/** account_sdk_source_info：优先 Cookie，缺失时以默认 browserInfo 模板编码并回写 */
function resolveAccountSdkSourceInfo(http) {
	const stored = http.jar.get("sdk_source_info");
	if (stored) return stored;
	const info = encodeBrowserInfo({
		...DEFAULT_BROWSER_INFO,
		performance: {
			...DEFAULT_BROWSER_INFO.performance,
			timeOrigin: Date.now()
		},
		browser: {
			...DEFAULT_BROWSER_INFO.browser,
			t: String(Date.now())
		}
	});
	http.jar.set("sdk_source_info", info);
	return info;
}
function signExtras(http, bodyWire = "") {
	const extras = {
		userAgent: http.getUserAgent(),
		enableABogus: http.enableABogus,
		appKey: DESKTOP_PASSPORT_APP_KEY,
		aBogusVariant: "jumpbyte-desktop",
		bodyWire
	};
	const msToken = http.getMsToken();
	if (msToken) extras.msToken = msToken;
	return extras;
}
function sleep$1(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

//#endregion
//#region src/core/im/types.ts
let GroupJoinRequestStatus = /* @__PURE__ */ function(GroupJoinRequestStatus) {
	GroupJoinRequestStatus[GroupJoinRequestStatus["PENDING"] = 1] = "PENDING";
	GroupJoinRequestStatus[GroupJoinRequestStatus["APPROVED"] = 2] = "APPROVED";
	GroupJoinRequestStatus[GroupJoinRequestStatus["REJECTED"] = 3] = "REJECTED";
	GroupJoinRequestStatus[GroupJoinRequestStatus["INVALID"] = 4] = "INVALID";
	return GroupJoinRequestStatus;
}({});
let FriendRequestStatus = /* @__PURE__ */ function(FriendRequestStatus) {
	FriendRequestStatus[FriendRequestStatus["PENDING"] = 1] = "PENDING";
	FriendRequestStatus[FriendRequestStatus["APPROVED"] = 2] = "APPROVED";
	FriendRequestStatus[FriendRequestStatus["REJECTED"] = 3] = "REJECTED";
	FriendRequestStatus[FriendRequestStatus["INVALID"] = 4] = "INVALID";
	return FriendRequestStatus;
}({});

//#endregion
//#region src/core/im/content.ts
/** messageType=1 文本 content（HTTP SDK 可投递） */
function buildLegacyTextContent(text) {
	return JSON.stringify({ text });
}
/** 创作者 Web 文本消息 content（messageType=7，HTTP 路径 aweType=774） */
function buildCreatorTextContent(text) {
	return JSON.stringify({
		text,
		aweType: 774
	});
}
/** Desktop IM 文本 content；字段和值与 jumpbyte 的成功 HAR 保持一致。 */
function buildDesktopTextContent(text, mentions = []) {
	return JSON.stringify({
		aweType: 700,
		type: 0,
		richTextInfos: mentions.map((mention) => ({
			infoType: 1,
			location: mention.location,
			length: mention.length,
			info: { uid: mention.uid }
		})),
		text
	});
}
function buildImageContent(image) {
	return JSON.stringify({
		resource_url: {
			oid: image.oid,
			skey: image.skey,
			data_size: image.dataSize,
			md5: image.md5
		},
		cover_height: image.height,
		cover_width: image.width,
		check_pics: [],
		md5: image.md5,
		from_gallery: 1,
		aweType: image.format === "gif" ? 2703 : 2702
	});
}
/** 文件消息 content（messageType=6，aweType=15001，字段与官方接收样例同形） */
function buildFileContent(file) {
	return JSON.stringify({
		aweType: 15001,
		uri: file.uri,
		skey: file.skey,
		md5: file.md5,
		name: file.name,
		data_size: file.dataSize,
		format: file.name.includes(".") ? file.name.split(".").pop().toLowerCase() : "",
		createdAt: 0,
		is_card: false,
		msgHint: ""
	});
}
function buildVideoContent(video) {
	return JSON.stringify({
		video: {
			tkey: video.tkey,
			md5: video.md5,
			skey: video.skey
		},
		poster: {
			oid: video.poster.oid,
			md5: video.poster.md5,
			skey: video.poster.skey
		},
		height: video.height,
		width: video.width,
		check_pics: video.checkPics ?? []
	});
}
function buildReplyPayload(options) {
	const hint = JSON.stringify({
		refmsg_type: options.referencedMessageType,
		content: options.referencedText ?? "",
		refmsg_uid: options.referencedUid,
		refmsg_sec_uid: options.referencedSecUid ?? "",
		nickname: options.nickname ?? "",
		refmsg_content: "",
		version: 0,
		itemId: "",
		scene_type: 0
	});
	const reference = {
		referencedMessageId: options.referencedMessageId,
		hint
	};
	if (options.rootMessageId) reference.rootMessageId = options.rootMessageId;
	if (options.rootMessageConvIndex) reference.rootMessageConvIndex = options.rootMessageConvIndex;
	return {
		content: buildDesktopTextContent(options.text),
		reference
	};
}
function objectValue(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}
function stringArray(value) {
	return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}
function imageFromObject(value) {
	const resource = objectValue(value["resource_url"]) ?? value;
	const oid = String(resource["oid"] ?? resource["uri"] ?? "");
	const skey = String(resource["skey"] ?? "");
	const urls = (name) => stringArray(resource[name] ?? value[name]);
	if (!oid && !skey && ![
		"origin_url_list",
		"large_url_list",
		"medium_url_list",
		"thumb_url_list"
	].some((name) => urls(name).some(Boolean))) return undefined;
	return {
		oid,
		skey,
		md5: String(resource["md5"] ?? value["md5"] ?? ""),
		dataSize: Number(resource["data_size"] ?? value["data_size"] ?? 0),
		width: Number(value["cover_width"] ?? resource["width"] ?? 0),
		height: Number(value["cover_height"] ?? resource["height"] ?? 0),
		originUrls: urls("origin_url_list"),
		largeUrls: urls("large_url_list"),
		mediumUrls: urls("medium_url_list"),
		thumbUrls: urls("thumb_url_list")
	};
}
/** wire 消息类型用于区分同形 resource_url（如语音 vs 图片） */
function parseMessageContent(content, messageType) {
	let value;
	try {
		const decoded = JSON.parse(content);
		if (!objectValue(decoded)) return {
			kind: "unknown",
			text: content,
			aweType: 0,
			value: content
		};
		value = decoded;
	} catch {
		return {
			kind: "text",
			text: content,
			aweType: 0
		};
	}
	const aweType = Number(value["aweType"] ?? value["awe_type"] ?? 0);
	const text = String(value["text"] ?? value["content"] ?? value["display_name"] ?? "");
	if (messageType === 17) {
		const resource = objectValue(value["resource_url"]);
		return {
			kind: "audio",
			text,
			aweType,
			audio: {
				urls: stringArray(resource?.["url_list"]),
				uri: String(resource?.["uri"] ?? "")
			},
			value
		};
	}
	if (messageType === 6 || messageType === 150) {
		return {
			kind: "file",
			text: String(value["name"] ?? ""),
			aweType,
			value,
			file: {
				uri: String(value["uri"] ?? ""),
				skey: String(value["skey"] ?? ""),
				md5: String(value["md5"] ?? ""),
				name: String(value["name"] ?? ""),
				dataSize: Number(value["data_size"] ?? 0)
			}
		};
	}
	if (messageType === 73 || messageType === 90) {
		return {
			kind: "text",
			text: String(value["hint"] ?? ""),
			aweType
		};
	}
	if (messageType === 1 && aweType === 133) {
		return {
			kind: "text",
			text: "",
			aweType
		};
	}
	if (messageType === 26) {
		return {
			kind: "link",
			text: String(value["title"] ?? ""),
			aweType,
			value,
			link: {
				url: String(value["link_url"] ?? ""),
				title: String(value["title"] ?? ""),
				description: String(value["desc"] ?? ""),
				coverUrl: String(value["cover_url"] ?? "")
			}
		};
	}
	if (messageType === 25) {
		return {
			kind: "user",
			text: String(value["name"] ?? ""),
			aweType,
			value,
			user: {
				uid: String(value["uid"] ?? ""),
				secUid: String(value["secUID"] ?? ""),
				name: String(value["name"] ?? ""),
				avatarUrl: stringArray(objectValue(value["avatar"])?.["url_list"])[0] ?? ""
			}
		};
	}
	if (messageType === 8 || messageType === 77 || messageType == null && aweType === 800) {
		const title = String(value["content_title"] ?? "");
		return {
			kind: "share",
			text: text || title,
			aweType,
			share: {
				itemId: String(value["itemId"] ?? ""),
				title,
				authorUid: String(value["uid"] ?? ""),
				authorSecUid: String(value["secUID"] ?? "")
			},
			value
		};
	}
	if (messageType === 136) {
		const summary = Array.isArray(value["list_content"]) ? value["list_content"] : [];
		const refs = Array.isArray(value["msg_ids"]) ? value["msg_ids"] : [];
		const refById = new Map(refs.map((ref) => [String(ref?.["msg_id"] ?? ""), ref]));
		const nodes = [];
		for (const item of summary) {
			const msgId = String(item?.["msgid"] ?? "");
			const ref = refById.get(msgId);
			nodes.push({
				uid: String(ref?.["uid"] ?? ""),
				nickname: String(item?.["nick_name"] ?? ""),
				text: String(item?.["text"] ?? ""),
				msgType: Number(ref?.["msg_type"] ?? 0),
				aweType: Number(ref?.["awe_type"] ?? 0),
				msgId,
				...ref?.["sec_uid"] ? { secUid: String(ref["sec_uid"]) } : {},
				...ref?.["create_time"] ? { createTime: Number(ref["create_time"]) } : {}
			});
		}
		return {
			kind: "forward",
			text: "[合并转发]",
			aweType,
			nodes,
			value
		};
	}
	if (messageType != null && ![
		1,
		2,
		5,
		7,
		27,
		30
	].includes(messageType)) {
		return {
			kind: "unknown",
			text,
			aweType,
			value
		};
	}
	const image = imageFromObject(value);
	if (image) return {
		kind: "image",
		text,
		aweType: aweType || 2702,
		image
	};
	const videoValue = objectValue(value["video"]);
	if (videoValue) {
		const posterValue = objectValue(value["poster"]);
		const poster = posterValue ? imageFromObject(posterValue) : undefined;
		const video = {
			tkey: String(videoValue["tkey"] ?? ""),
			skey: String(videoValue["skey"] ?? ""),
			md5: String(videoValue["md5"] ?? ""),
			width: Number(value["width"] ?? 0),
			height: Number(value["height"] ?? 0),
			checkPics: stringArray(value["check_pics"]),
			...poster ? { poster } : {}
		};
		return {
			kind: "video",
			text,
			aweType,
			video
		};
	}
	const emojiUrl = objectValue(value["url"]);
	const url = String(emojiUrl?.["uri"] ?? stringArray(emojiUrl?.["url_list"])[0] ?? "");
	if (aweType === 507 || url) return {
		kind: "emoji",
		text,
		aweType: aweType || 507,
		url
	};
	if (text || "text" in value) return {
		kind: "text",
		text,
		aweType
	};
	return {
		kind: "unknown",
		text,
		aweType,
		value
	};
}
/**
* 将简单 `{"text":"..."}` 或纯文本转为 type=7 内容。
* HTTP 默认 aweType=774；desktop 发送使用 normalizeDesktopTextMessageContent（aweType=700）。
*/
function normalizeTextMessageContent(content, msgType) {
	if (msgType === 1) {
		try {
			const j = JSON.parse(content);
			if (j.text != null) return content;
		} catch {
			return buildLegacyTextContent(content);
		}
		return content;
	}
	if (msgType !== 7) return content;
	try {
		const j = JSON.parse(content);
		if (j.text != null && j.aweType == null && !("ai_ext" in j)) {
			return buildCreatorTextContent(j.text);
		}
		if (j.aweType != null || j.ai_ext != null) return content;
	} catch {
		return buildCreatorTextContent(content);
	}
	return content;
}
/** 仅将普通文本转换成 Desktop IM 模板，富媒体保持原样。 */
function normalizeDesktopTextMessageContent(content, msgType) {
	if (msgType !== 7) return normalizeTextMessageContent(content, msgType);
	try {
		const value = JSON.parse(content);
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			return buildDesktopTextContent(content);
		}
		const record = value;
		const keys = Object.keys(record);
		const isPlainText = typeof record["text"] === "string" && keys.every((key) => [
			"text",
			"aweType",
			"type",
			"richTextInfos"
		].includes(key)) && (!Array.isArray(record["richTextInfos"]) || record["richTextInfos"].length === 0);
		return isPlainText ? buildDesktopTextContent(record["text"]) : content;
	} catch {
		return buildDesktopTextContent(content);
	}
}
/** 入站消息展示文本：解析失败时按 kind 回退占位符 */
function displayText(content, messageType) {
	const parsed = parseMessageContent(content, messageType);
	if (parsed.text) return parsed.text;
	if (parsed.kind === "image") return "[图片]";
	if (parsed.kind === "video") return "[视频]";
	if (parsed.kind === "emoji") return parsed.text || "[表情]";
	if (parsed.kind === "audio") return "[语音]";
	if (parsed.kind === "share") return "[分享作品]";
	return content;
}

//#endregion
//#region src/core/im/mappers.ts
function isGroupConversationId(conversationId) {
	return /^\d+$/.test(conversationId.trim());
}
function mapProtoConversationListItem(raw) {
	const conversationId = String(raw["conversationId"] ?? "");
	const conversationType = Number(raw["conversationType"] ?? 0);
	const core = raw["conversationCoreInfo"];
	const ext = raw["extInfo"];
	const setting = raw["userSetting"] ?? raw["conversationSettingInfo"];
	const memberBox = raw["members"] ?? raw["firstPageParticipants"];
	const avatar = String(core?.["icon"] ?? ext?.["icon"] ?? core?.["avatar"] ?? ext?.["avatar"] ?? "");
	if (isGroupConversationId(conversationId) && !avatar) {
		logger.debug(`[douyin:im] 群头像缺失: keys=${JSON.stringify(Object.keys(raw))} ` + `core=${JSON.stringify(core)?.slice(0, 400)} ext=${JSON.stringify(ext)?.slice(0, 400)}`);
	}
	const ownerUid = String(ext?.["ownerUid"] ?? ext?.["owner"] ?? core?.["owner"] ?? "");
	const members = (memberBox?.members ?? memberBox?.participants ?? []).map((member) => {
		const secUid = String(member["secUid"] ?? "");
		return {
			uid: String(member["uid"] ?? member["userId"] ?? ""),
			role: Number(member["role"] ?? 0),
			...secUid ? { secUid } : {}
		};
	}).filter((member) => member.uid && member.uid !== "0");
	return {
		conversationId,
		conversationShortId: String(raw["conversationShortId"] ?? ""),
		conversationType,
		isGroup: conversationType === 2 || isGroupConversationId(conversationId),
		name: String(ext?.["name"] ?? ""),
		...avatar ? { avatar } : {},
		...ownerUid && ownerUid !== "0" ? { ownerUid } : {},
		lastMessageTime: Number(setting?.["lastMsgTime"] ?? 0),
		members
	};
}
/**
* 从 conversationId 解析对端 UID。
* jumpbyte 私信格式: "0:1:{uid_a}:{uid_b}"
*/
function parsePeerFromConversationId(conversationId, myUid) {
	const parts = conversationId.split(":");
	if (parts.length >= 4 && parts[1] === "1") {
		const uidA = parts[2];
		const uidB = parts[3];
		if (uidA === myUid) return uidB;
		if (uidB === myUid) return uidA;
		return uidB;
	}
	return "";
}
/** 从 conversation 元数据构建 thread（对齐 douyin-im mapThread：peer 资料取 firstPageParticipants/userInfo 的 alias） */
function mapProtoConversationMeta(conv, messages, myUid) {
	const threadId = conv["conversationId"] ?? "";
	const conversationType = conv["conversationType"] ?? 1;
	const peerUid = parsePeerFromConversationId(threadId, myUid);
	const participantPage = conv["firstPageParticipants"] ?? conv["members"];
	const userInfo = conv["userInfo"];
	const candidates = participantPage?.participants ?? participantPage?.members ?? [];
	const peerMember = candidates.find((member) => String(member["userId"] ?? member["uid"] ?? "") === peerUid);
	const peerInfo = peerMember ?? (String(userInfo?.["userId"] ?? userInfo?.["uid"] ?? "") === peerUid ? userInfo : undefined);
	const peerSecUid = String(peerInfo?.["secUid"] ?? "");
	const peerNick = String(peerInfo?.["alias"] ?? peerInfo?.["nickname"] ?? "");
	const thread = {
		threadId,
		...conv["conversationShortId"] != null ? { conversationShortId: String(conv["conversationShortId"]) } : {},
		conversationType,
		peer: {
			uid: peerUid,
			nickname: peerNick,
			...peerSecUid ? { secUid: peerSecUid } : {}
		},
		unreadCount: Number(conv["badgeCount"] ?? conv["unreadCount"] ?? 0),
		updateTime: Number(conv["extInfo"]?.["lastActiveTime"] ?? 0),
		...conv["inboxType"] != null ? { inboxType: conv["inboxType"] } : {}
	};
	const lastMsg = messages.find((m) => m["conversationId"] === threadId);
	if (lastMsg) {
		thread.lastMessage = mapProtoMessage(lastMsg);
		if (!thread.updateTime) thread.updateTime = thread.lastMessage.createTime;
	}
	return thread;
}
/** 从单条 message 记录构建 thread（无 conversations 字段时） */
function mapProtoConversation(raw, myUid) {
	const threadId = raw["conversationId"] ?? "";
	const conversationType = raw["conversationType"] ?? 1;
	const peerUid = parsePeerFromConversationId(threadId, myUid) || (conversationType === 1 ? String(raw["sender"] ?? "") : "");
	const ext = raw["ext"];
	const thread = {
		threadId,
		...raw["conversationShortId"] != null ? { conversationShortId: String(raw["conversationShortId"]) } : {},
		conversationType,
		peer: {
			uid: peerUid,
			nickname: "",
			...raw["secSender"] && String(raw["sender"]) === peerUid ? { secUid: String(raw["secSender"]) } : {}
		},
		unreadCount: 0,
		updateTime: raw["createTime"] ?? 0,
		...ext?.["s:is_stranger"] === "true" ? { isStranger: true } : {}
	};
	if (raw["content"]) {
		thread.lastMessage = mapProtoMessage(raw);
	}
	return thread;
}
function dedupeThreads(threads) {
	const byId = new Map();
	for (const t of threads) {
		const prev = byId.get(t.threadId);
		if (!prev || t.updateTime >= prev.updateTime) {
			byId.set(t.threadId, t);
		}
	}
	return [...byId.values()];
}
function mapProtoMessage(raw) {
	const senderSecUid = String(raw["secSender"] ?? "");
	const indexInConversation = String(raw["indexInConversation"] ?? "");
	const indexInConversationV2 = String(raw["indexInConversationV2"] ?? "");
	return {
		msgId: String(raw["serverMessageId"] ?? ""),
		threadId: raw["conversationId"] ?? "",
		senderUid: String(raw["sender"] ?? ""),
		...senderSecUid ? { senderSecUid } : {},
		content: raw["content"] ?? "",
		msgType: raw["messageType"] ?? 0,
		createTime: raw["createTime"] ?? 0,
		status: raw["status"] ?? 0,
		...indexInConversation ? { indexInConversation } : {},
		...indexInConversationV2 ? { indexInConversationV2 } : {}
	};
}
/** thread 对端信息 → 业务 peer 摘要 */
function threadPeerSummary(thread) {
	const peer = thread.peer;
	return {
		uid: peer.uid,
		...peer.secUid ? { secUid: peer.secUid } : {},
		nickname: peer.nickname ?? ""
	};
}
/** P2P 会话线程 → 好友信息 */
function mapThreadToFriend(thread) {
	const peer = threadPeerSummary(thread);
	if (!peer.uid || !/^\d+$/.test(peer.uid)) return undefined;
	return {
		uid: peer.uid,
		...peer.secUid ? { secUid: peer.secUid } : {},
		nickname: peer.nickname,
		conversationId: thread.threadId,
		conversationShortId: thread.conversationShortId ?? "",
		...thread.lastMessage ? { lastMessage: thread.lastMessage } : {},
		lastMessageTime: thread.lastMessage?.createTime ?? thread.updateTime,
		unreadCount: thread.unreadCount
	};
}
/** 陌生人会话线程 → 陌生人信息 */
function mapThreadToStranger(thread) {
	const peer = threadPeerSummary(thread);
	if (!peer.uid) return undefined;
	return {
		uid: peer.uid,
		...peer.secUid ? { secUid: peer.secUid } : {},
		...peer.nickname ? { nickname: peer.nickname } : {},
		conversationId: thread.threadId,
		conversationShortId: thread.conversationShortId ?? "",
		...thread.lastMessage ? { lastMessage: thread.lastMessage } : {},
		lastMessageTime: thread.lastMessage?.createTime ?? thread.updateTime,
		unreadCount: thread.unreadCount
	};
}

//#endregion
//#region src/core/im/protocol/proto.ts
/**
* 抖音 IM 协议 schema（等价迁移自 douyin-im src/services/im/proto/im.proto）。
* tsdown 打包单文件时独立 .proto 不会被携带，因此内联为字符串常量，
* 用 protobuf.parse（keepCase=false，与 protobuf.load 默认行为一致）解析。
*/
const IM_PROTO_SOURCE = `
syntax = "proto3";
package im;

message RequestEnvelope {
  int32 cmd = 1;
  int64 sequence_id = 2;
  string sdk_version = 3;
  string token = 4;
  int32 refer = 5;
  int32 inbox_type = 6;
  string build_number = 7;
  RequestPayload body = 8;
  string device_id = 9;
  string channel = 10;
  string device_platform = 11;
  string device_type = 12;
  string os_version = 13;
  string version_code = 14;
  map<string, string> headers = 15;
  int32 config_id = 16;
  TokenInfo token_info = 17;
  int32 auth_type = 18;
  string biz = 21;
  string access = 22;
  string ts_sign = 23;
  string sdk_cert = 24;
  string reuqest_sign = 25;
}

message TokenInfo {
  int32 mark_id = 1;
  int32 type = 2;
  int32 app_id = 3;
  int64 user_id = 4;
  int64 timestamp = 5;
}

message RequestPayload {
  SendMessageRequest send_message = 100;
  InboxRequest inbox = 203;
  ConversationMessagesRequest conversation_messages = 301;
  SendUserActionRequest send_user_action = 410;
  SendInputStatusRequest send_input_status = 411;
  DeleteConversationRequest delete_conversation = 603;
  // Native rawMarkConversationRead uses outer cmd 2002 but keeps body oneof tag 604.
  MarkConversationReadRequest mark_conversation_read = 604;
  ConversationParticipantsListRequest conversation_participants = 605;
  GetConversationInfoV2Request get_conversation_info_v2 = 608;
  CreateConversationV2Request create_conversation_v2 = 609;
  GetConversationInfoListV2Request get_conversation_info_list_v2 = 610;
  DissolveConversationRequest dissolve_conversation = 614;
  ConversationAddParticipantsRequest conversation_add_participants = 650;
  ConversationRemoveParticipantsRequest conversation_remove_participants = 651;
  ConversationLeaveRequest leave_conversation = 652;
  ConversationSetRoleRequest conversation_set_role = 653;
  DeleteMessageRequest delete_message = 701;
  RecallMessageRequest recall_message = 702;
  ModifyMessagePropertyRequest modify_message_property = 705;
  SetConversationCoreInfoRequest set_conversation_core_info = 902;
  GetConversationSettingInfoRequest get_conversation_setting_info = 920;
  SetConversationSettingInfoRequest set_conversation_setting_info = 921;
  ConversationListRequest conversation_list = 2006;
  AckConversationApplyRequest ack_conversation_apply = 2025;
  GetConversationAuditListRequest get_conversation_audit_list = 2027;
  GetFriendReceiveApplyListRequest get_friend_receive_apply_list = 20481;
  ReplyFriendApplyRequest reply_friend_apply = 2049;
  GetRecentStrangerMessageReqBody get_recent_stranger_message = 2047;
}

message GetConversationInfoV2Request {
  string conversation_id = 1;
  int64 conversation_short_id = 2;
  int32 conversation_type = 3;
}

message GetConversationInfoListV2Request {
  repeated GetConversationInfoV2Request conversation_info_list = 1;
}

message GetConversationInfoV2Response {
  ConversationV2 conversation_info = 1;
}

message GetConversationInfoListV2Response {
  repeated ConversationV2 conversation_info_list = 1;
}

message SendUserActionRequest {
  string conversation_id = 1;
  int32 conversation_type = 2;
  int64 conversation_short_id = 3;
  int32 action_type = 4;
  map<string, string> extra = 5;
}

message SendInputStatusRequest {
  string conversation_id = 1;
  int32 conversation_type = 2;
  int64 conversation_short_id = 3;
  int32 status = 4;
  map<string, string> extra = 5;
}

message DissolveConversationRequest {
  string conversation_id = 1;
  int64 conversation_short_id = 2;
  int32 conversation_type = 3;
}

message ModifyPropertyContent {
  int32 operation = 1;
  string key = 2;
  string value = 3;
  string idempotent_id = 4;
}

message ModifyPropertyBody {
  string conversation_id = 1;
  int32 conversation_type = 2;
  int64 conversation_short_id = 3;
  int64 server_message_id = 4;
  string client_message_id = 5;
  repeated ModifyPropertyContent modify_property_content = 6;
}

message ModifyMessagePropertyRequest {
  repeated ModifyPropertyBody property_list = 1;
  string ticket = 2;
}

message GetFriendReceiveApplyListRequest {
  int64 cursor = 1;
  int64 limit = 2;
  bool get_total_count = 3;
  int32 status = 4;
}

message ReplyFriendApplyRequest {
  repeated int64 user_id = 1;
  int32 attitude = 2;
  map<string, string> ext = 3;
}

message CreateConversationV2Request {
  int32 conversation_type = 1;
  repeated int64 participants = 2;
  bool persistent = 3;
  string idempotent_id = 4;
  string name = 6;
  string avatar_url = 7;
  string description = 8;
  map<string, string> biz_ext = 11;
}

message ConversationAddress {
  string conversation_id = 1;
  int64 conversation_short_id = 2;
  int32 conversation_type = 3;
}

message DeleteConversationRequest {
  string conversation_id = 1;
  int64 conversation_short_id = 2;
  int32 conversation_type = 3;
  int64 last_message_index = 4;
  int64 last_message_index_v2 = 5;
  int32 badge_count = 6;
}

message MarkConversationReadRequest {
  string conversation_id = 1;
  int64 conversation_short_id = 2;
  int32 conversation_type = 3;
  int64 read_message_index = 4;
  int64 conv_unread_count = 5;
  int64 total_unread_count = 6;
  int64 read_message_index_v2 = 7;
  int32 read_badge_count = 8;
  string ticket = 9;
  int64 server_message_id = 10;
}

message ConversationAddParticipantsRequest {
  string conversation_id = 1;
  int64 conversation_short_id = 2;
  int32 conversation_type = 3;
  repeated int64 participants = 4;
  map<string, string> biz_ext = 5;
}

message ConversationParticipantsListRequest {
  string conversation_id = 1;
  int64 conversation_short_id = 2;
  int32 conversation_type = 3;
  int64 cursor = 4;
  int32 limit = 5;
}

message ConversationSetRoleRequest {
  string conversation_id = 1;
  int64 conversation_short_id = 2;
  int32 conversation_type = 3;
  map<int64, int32> roles = 4;
}

message ConversationRemoveParticipantsRequest {
  string conversation_id = 1;
  int64 conversation_short_id = 2;
  int32 conversation_type = 3;
  repeated int64 participants = 4;
  map<string, string> biz_ext = 5;
}

message ConversationLeaveRequest {
  string conversation_id = 1;
  int64 conversation_short_id = 2;
  int32 conversation_type = 3;
}

message DeleteMessageRequest {
  string conversation_id = 1;
  int64 conversation_short_id = 2;
  int32 conversation_type = 3;
  int64 message_id = 4;
}

message SetConversationCoreInfoRequest {
  string conversation_id = 1;
  int64 conversation_short_id = 2;
  int32 conversation_type = 3;
  string name = 4;
  string desc = 5;
  string icon = 6;
  string notice = 7;
  bool is_name_set = 8;
  bool is_desc_set = 9;
  bool is_icon_set = 10;
  bool is_notice_set = 11;
  map<string, string> ext = 12;
}

message SetConversationSettingInfoRequest {
  string conversation_id = 1;
  int64 conversation_short_id = 2;
  int32 conversation_type = 3;
  bool set_stick_on_top = 4;
  bool set_mute = 5;
  bool set_favorite = 6;
}

message GetConversationSettingInfoRequest {
  int64 conversation_short_id = 2;
}

message ConversationListRequest {
  int32 list_type = 1;
  int64 cursor = 2;
  int32 sort_type = 3;
  int32 limit = 4;
}

message AckConversationApplyRequest {
  int64 apply_id = 1;
  int32 apply_status = 2;
  map<string, string> biz_ext = 3;
}

message GetConversationAuditListRequest {
  int64 cursor = 1;
  int32 limit = 2;
  int64 conv_short_id = 3;
  bool no_clear_unread = 4;
}

message RecallMessageRequest {
  string conversation_id = 1;
  int64 conversation_short_id = 2;
  int32 conversation_type = 3;
  int64 server_message_id = 4;
}

message InboxRequest {
  int64 cursor = 1;
  int32 new_user = 2;
  int32 init_sub_type = 3;
  int32 conv_limit = 4;
  int32 msg_limit = 5;
}

message SendMessageRequest {
  string conversation_id = 1;
  int32 conversation_type = 2;
  int64 conversation_short_id = 3;
  string content = 4;
  map<string, string> ext = 5;
  int32 message_type = 6;
  string ticket = 7;
  string client_message_id = 8;
  repeated int64 mentioned_users = 9;
  ReferencedMessageInfo ref_msg_info = 11;
}

message ReferencedMessageInfo {
  int64 referenced_message_id = 1;
  string hint = 2;
  int64 root_message_id = 3;
  int64 root_message_conv_index = 4;
}

message ConversationMessagesRequest {
  string conversation_id = 1;
  int32 conversation_type = 2;
  int64 conversation_short_id = 3;
  int32 direction = 4;
  int64 anchor_index = 5;
  int32 limit = 6;
}

message ResponseEnvelope {
  int32 cmd = 1;
  int64 sequence_id = 2;
  int32 status_code = 3;
  string error_desc = 4;
  int32 inbox_type = 5;
  ResponsePayload body = 6;
  string log_id = 7;
  map<string, string> headers = 8;
  int64 start_time_stamp = 9;
  int64 request_arrived_time = 10;
  int64 server_execution_end_time = 11;
  int64 user_id = 13;
}

message Frame {
  uint64 seqid = 1;
  uint64 logid = 2;
  int32 service = 3;
  int32 method = 4;
  repeated FrameHeaderEntry headers = 5;
  string payload_encoding = 6;
  string payload_type = 7;
  bytes payload = 8;
}

message FrameHeaderEntry {
  string key = 1;
  string value = 2;
}

message ResponsePayload {
  SendMessageResponse send_message = 100;
  InboxResponse inbox = 203;
  ConversationMessagesResponse conversation_messages = 301;
  NewMessageNotify has_new_message_notify = 500;
  MarkConversationReadNotify has_mark_read_notify = 501;
  ConversationInfoUpdatedNotify has_conversation_info_updated_notify = 502;
  NewP2PMessageNotify has_new_p2p_message_notify = 504;
  NewFriendMessageNotify new_friend_message_notify = 507;
  ConversationParticipantsListResponse conversation_participants = 605;
  GetConversationInfoV2Response get_conversation_info_v2 = 608;
  CreateConversationV2Response create_conversation_v2 = 609;
  GetConversationInfoListV2Response get_conversation_info_list_v2 = 610;
  EmptyActionResponse dissolve_conversation = 614;
  ConversationAddParticipantsResponse conversation_add_participants = 650;
  ConversationRemoveParticipantsResponse conversation_remove_participants = 651;
  ConversationSetRoleResponse conversation_set_role = 653;
  RecallMessageResponse recall_message = 702;
  ModifyMessagePropertyResponse modify_message_property = 705;
  SetConversationCoreInfoResponse set_conversation_core_info = 902;
  GetConversationSettingInfoResponse get_conversation_setting_info = 920;
  SetConversationSettingInfoResponse set_conversation_setting_info = 921;
  ConversationListResponse conversation_list = 2006;
  AckConversationApplyResponse ack_conversation_apply = 2025;
  GetConversationAuditListResponse get_conversation_audit_list = 2027;
  GetFriendReceiveApplyListResponse get_friend_receive_apply_list = 20481;
  EmptyActionResponse reply_friend_apply = 2049;
  GetRecentStrangerMessageRespBody get_recent_stranger_message = 2047;
}

message GetRecentStrangerMessageReqBody {
  int64 latest_stranger_version = 1;
  int64 earliest_stranger_version = 2;
  string source = 3;
  int32 new_user = 4;
  map<string, string> ext = 5;
  string biz_info = 6;
}

message ConversationRecentMessage {
  int64 conversation_short_id = 1;
  repeated ConversationMessage messages = 2;
  int64 version = 3;
  int32 badge_count = 4;
  string conversation_id = 5;
  repeated ConversationMessage ext_messages = 6;
}

message GetRecentStrangerMessageRespBody {
  int64 next_stranger_version = 1;
  repeated ConversationRecentMessage messages = 2;
  bool has_more = 3;
}

message EmptyActionResponse {}

message ModifyMessagePropertyResponse {
  int32 status = 1;
  int64 version = 2;
}

message Profile {
  string nick_name = 1;
  string protrait = 2;
  string basic_ext_info = 3;
  string detail_ext_info = 4;
  int64 uid = 5;
}

message ApplyUserInfo {
  int64 user_id = 1;
  int64 apply_time_second = 2;
  map<string, string> ext = 3;
  int32 status = 4;
  Profile profile = 5;
}

message GetFriendReceiveApplyListResponse {
  int64 next_cursor = 1;
  bool has_more = 2;
  repeated ApplyUserInfo user_list = 3;
  int64 total_count = 4;
}

message NewFriendMessageNotify {
  int32 message_type = 1;
  int64 from_id = 2;
  int64 to_id = 3;
  string content = 4;
  map<string, string> ext = 5;
}

message CreateConversationV2Response {
  ConversationV2 conversation = 1;
  int64 check_code = 2;
  string check_message = 3;
  string extra_info = 4;
  int32 status = 5;
}

message ConversationApplyInfo {
  int64 user_id = 1;
  int64 conv_short_id = 2;
  int32 conversation_type = 3;
  int32 apply_status = 4;
  int64 apply_id = 5;
  int64 create_time = 6;
  int64 modify_time = 7;
  int64 modify_user = 8;
  string sec_uid = 9;
  int64 invite_user_id = 10;
  string sec_invite_uid = 11;
  map<string, string> ext = 12;
  string apply_reason = 13;
}

message AckConversationApplyResponse {
  ConversationApplyInfo apply_info = 1;
  int32 status = 2;
  int64 check_code = 3;
  string check_message = 4;
}

message GetConversationAuditListResponse {
  repeated ConversationApplyInfo apply_info_list = 1;
  int64 next_cursor = 2;
  bool has_more = 3;
}

message ConversationAddParticipantsResponse {
  repeated int64 success_participants = 1;
  repeated int64 failed_participants = 2;
  int32 status = 3;
  string extra_info = 4;
  int64 check_code = 5;
  string check_message = 6;
  repeated SecUidPair sec_success_participants = 7;
  repeated SecUidPair sec_failed_participants = 8;
}

message SecUidPair {
  int64 uid = 1;
  string sec_uid = 2;
}

message ConversationParticipant {
  int64 user_id = 1;
  int64 sort_order = 2;
  int32 role = 3;
  string alias = 4;
  string sec_uid = 5;
  int32 blocked = 6;
  int64 left_block_time = 7;
  map<string, string> ext = 8;
}

message ConversationParticipantsPage {
  repeated ConversationParticipant participants = 1;
  bool has_more = 2;
  int64 cursor = 3;
}

message ConversationParticipantsListResponse {
  ConversationParticipantsPage participants_page = 1;
}

message ConversationSetRoleResponse {
  repeated int64 success_participants = 1;
  repeated int64 failed_participants = 2;
  int32 status = 3;
  string extra_info = 4;
  int64 check_code = 5;
  string check_message = 6;
}

message ConversationRemoveParticipantsResponse {
  repeated int64 failed_participants = 1;
  int32 status = 2;
  string extra_info = 3;
  int64 check_code = 4;
  string check_message = 5;
}

message SetConversationCoreInfoResponse {
  int32 status = 2;
  string extra_info = 3;
  int64 check_code = 4;
  string check_message = 5;
}

message SetConversationSettingInfoResponse {
  int32 status = 2;
  int64 check_code = 3;
  string check_message = 4;
  string extra_info = 5;
}

message GetConversationSettingInfoResponse {
  ConversationSettingInfo conversation_setting_info = 1;
  int32 status = 2;
  int64 check_code = 3;
  string check_message = 4;
  string extra_info = 5;
}

message ConversationSettingInfo {
  string conversation_id = 1;
  int64 conversation_short_id = 2;
  int32 conversation_type = 3;
  int32 mute = 6;
  int32 stick_on_top = 7;
  int32 inbox_type = 8;
  int32 favorite = 11;
}

message ConversationListResponse {
  repeated Conversation conversations = 1;
}

message RecallMessageResponse {
  int32 status = 1;
}

message NewMessageNotify {
  reserved 1;
  string conversation_id = 2;
  int32 conversation_type = 3;
  int32 notify_type = 4;
  ConversationMessage message = 5;
}

message NewP2PMessageNotify {
  reserved 1;
  string conversation_id = 2;
  int32 conversation_type = 3;
  ConversationMessage message = 4;
}

message MarkConversationReadNotify {
  string conversation_id = 1;
  int32 conversation_type = 2;
  int64 read_message_index = 3;
  int64 read_message_index_v2 = 4;
}

message ConversationInfoUpdatedNotify {
  Conversation conversation = 1;
}

message InboxResponse {
  repeated ConversationMessage messages = 1;
  repeated Conversation conversations = 2;
  int64 next_cursor = 3;
  int32 inbox_unread_count = 4;
  int32 has_more = 5;
  int32 filter_type = 6;
  int32 total_count = 7;
  int64 min_cursor = 8;
  int64 max_cursor = 9;
}

message ConversationV2 {
  string conversation_id = 1;
  int64 conversation_short_id = 2;
  int32 conversation_type = 3;
  string ticket = 4;
  ConversationParticipantsPage first_page_participants = 6;
  int32 participants_count = 7;
  bool is_participant = 8;
  int32 inbox_type = 9;
  int32 badge_count = 10;
  ConversationCoreInfo conversation_core_info = 50;
}

message ConversationCoreInfo {
  string conversation_id = 1;
  int64 conversation_short_id = 2;
  int32 conversation_type = 3;
  int64 info_version = 4;
  string name = 5;
  string desc = 6;
  string icon = 7;
  int32 inbox_type = 8;
  string notice = 9;
  map<string, string> ext = 11;
  int64 owner = 12;
  string sec_owner = 13;
  int64 creator_uid = 17;
  int64 create_time = 18;
}

message Conversation {
  string conversation_id = 1;
  int64 conversation_short_id = 2;
  int32 conversation_type = 3;
  string ticket = 4;
  int32 inbox_type = 5;
  ConversationMembers members = 6;
  int64 min_index = 10;
  int64 max_index = 11;
  int64 unread_count = 15;
  ConversationLastSender last_sender = 20;
  ConversationExtInfo ext_info = 50;
  ConversationUserSetting user_setting = 51;
}

message ConversationMembers {
  repeated ConversationMember members = 1;
}

message ConversationMember {
  int64 uid = 1;
  int32 role = 3;
  string sec_uid = 5;
}

message ConversationLastSender {
  int64 sender_uid = 1;
  int32 status = 3;
  string nickname = 4;
  string sec_uid = 5;
}

message ConversationExtInfo {
  string conversation_id = 1;
  int64 conversation_short_id = 2;
  int32 conversation_type = 3;
  int64 last_active_time = 4;
  string name = 5;
  string avatar = 7;
  int64 owner_uid = 12;
  string owner_sec_uid = 13;
  int64 create_time = 18;
}

message ConversationUserSetting {
  string conversation_id = 1;
  int64 conversation_short_id = 2;
  int32 conversation_type = 3;
  int64 last_msg_time = 10;
}

message SendMessageResponse {
  int64 server_message_id = 1;
  string extra_info = 2;
  int32 status = 3;
  string client_message_id = 4;
  int64 check_code = 5;
  string check_message = 6;
}

message ConversationMessagesResponse {
  repeated ConversationMessage messages = 1;
  int64 next_cursor = 2;
  bool has_more = 3;
}

message ConversationMessage {
  string conversation_id = 1;
  int32 conversation_type = 2;
  int64 server_message_id = 3;
  int64 index_in_conversation = 4;
  int64 conversation_short_id = 5;
  int32 message_type = 6;
  int64 sender = 7;
  string content = 8;
  map<string, string> ext = 9;
  int64 create_time = 10;
  int64 version = 11;
  int32 status = 12;
  int64 order_in_conversation = 13;
  string sec_sender = 14;
  int64 index_in_conversation_v2 = 17;
}
`;
let rootPromise;
/** 解析内联 proto（keepCase=false，与参考项目 protobuf.load 行为一致），进程内缓存 */
function loadRoot() {
	rootPromise ??= new Promise((resolve, reject) => {
		try {
			resolve(protobuf.parse(IM_PROTO_SOURCE, { keepCase: false }).root);
		} catch (error) {
			reject(error instanceof Error ? error : new Error(String(error)));
		}
	});
	return rootPromise;
}

//#endregion
//#region src/core/im/protocol/codec.ts
const SDK_VERSION = "0.7.2-fix.1";
const BUILD_NUMBER = "2f4951d:fix/douyin-creator-fix";
let sequenceCounter = 0;
async function encodeRequest(opts) {
	const root = await loadRoot();
	const RequestEnvelope = root.lookupType("im.RequestEnvelope");
	sequenceCounter += 1;
	const envelope = {
		cmd: opts.cmd,
		sequenceId: opts.sequenceId ?? sequenceCounter,
		sdkVersion: opts.sdkVersion ?? SDK_VERSION,
		token: opts.token,
		refer: opts.refer ?? 3,
		inboxType: opts.inboxType ?? 1,
		buildNumber: opts.buildNumber ?? BUILD_NUMBER,
		deviceId: opts.deviceId ?? "",
		devicePlatform: opts.devicePlatform ?? "douyin_pc",
		versionCode: opts.versionCode ?? "",
		headers: opts.headers ?? {},
		authType: opts.authType ?? 3,
		biz: opts.biz ?? "douyin_creator",
		access: opts.access ?? "im_api"
	};
	if (opts.body) {
		envelope["body"] = opts.body;
	}
	const errMsg = RequestEnvelope.verify(envelope);
	if (errMsg) {
		throw new Error(`protobuf verify failed: ${errMsg}`);
	}
	const message = RequestEnvelope.create(envelope);
	return RequestEnvelope.encode(message).finish();
}
async function decodeResponseRaw(buffer) {
	const root = await loadRoot();
	const ResponseEnvelope = root.lookupType("im.ResponseEnvelope");
	const decoded = ResponseEnvelope.decode(buffer);
	return ResponseEnvelope.toObject(decoded, {
		longs: String,
		enums: String,
		defaults: true
	});
}

//#endregion
//#region src/core/im/protocol/wire.ts
const MAX_DEPTH = 8;
const textDecoder = new TextDecoder("utf-8", { fatal: true });
function decodeVarint(data, start) {
	let value = 0n;
	let shift = 0n;
	for (let pos = start; pos < data.length && shift < 70n; pos += 1, shift += 7n) {
		const byte = data[pos];
		value |= BigInt(byte & 127) << shift;
		if ((byte & 128) === 0) return {
			value,
			next: pos + 1
		};
	}
	return null;
}
function safeText(data) {
	try {
		const text = textDecoder.decode(data);
		for (const ch of text) {
			const code = ch.codePointAt(0);
			if (code < 32 && code !== 9 && code !== 10 && code !== 13) return null;
		}
		return text;
	} catch {
		return null;
	}
}
/**
* Best-effort protobuf decoder for traffic whose schema is not known yet.
* It never throws on a truncated frame: all completely decoded fields are returned.
*/
function decodeWire(data, depth = 0) {
	const fields = [];
	let pos = 0;
	while (pos < data.length) {
		const tag = decodeVarint(data, pos);
		if (!tag) break;
		pos = tag.next;
		const field = Number(tag.value >> 3n);
		const wireType = Number(tag.value & 7n);
		if (field === 0) break;
		if (wireType === 0) {
			const item = decodeVarint(data, pos);
			if (!item) break;
			pos = item.next;
			fields.push({
				field,
				type: "varint",
				value: item.value
			});
			continue;
		}
		if (wireType === 1 || wireType === 5) {
			const width = wireType === 1 ? 8 : 4;
			if (pos + width > data.length) break;
			const value = data.slice(pos, pos + width);
			pos += width;
			fields.push({
				field,
				type: wireType === 1 ? "fixed64" : "fixed32",
				value
			});
			continue;
		}
		if (wireType !== 2) break;
		const lengthItem = decodeVarint(data, pos);
		if (!lengthItem || lengthItem.value > BigInt(Number.MAX_SAFE_INTEGER)) break;
		pos = lengthItem.next;
		const length = Number(lengthItem.value);
		if (pos + length > data.length) break;
		const raw = data.slice(pos, pos + length);
		pos += length;
		const text = safeText(raw);
		const trimmed = text?.trimStart() ?? "";
		const knownText = trimmed.startsWith("{") || trimmed.startsWith("[") || /^0:\d+:/.test(trimmed) || /^\d+$/.test(trimmed) || trimmed.startsWith("MS4") || /^https?:\/\//.test(trimmed) || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(trimmed);
		if (text != null && knownText) {
			fields.push({
				field,
				type: "string",
				value: text
			});
			continue;
		}
		const nested = depth < MAX_DEPTH ? decodeWire(raw, depth + 1) : [];
		if (nested.length > 0) fields.push({
			field,
			type: "message",
			value: nested
		});
		else if (text != null) fields.push({
			field,
			type: "string",
			value: text
		});
		else fields.push({
			field,
			type: "bytes",
			value: raw
		});
	}
	return fields;
}
/** JSON-safe diagnostic tree. bigint is represented as decimal and bytes as base64. */
function decodeWireTree(data) {
	const convert = (field) => {
		if (field.type === "message") {
			return {
				f: field.field,
				t: field.type,
				v: field.value.map(convert)
			};
		}
		if (field.type === "varint") {
			return {
				f: field.field,
				t: field.type,
				v: field.value.toString()
			};
		}
		if (field.type === "string") return {
			f: field.field,
			t: field.type,
			v: field.value
		};
		return {
			f: field.field,
			t: field.type,
			v: Buffer.from(field.value).toString("base64")
		};
	};
	return decodeWire(data).map(convert);
}
function encodeVarint(value) {
	let remaining = BigInt(value);
	const bytes = [];
	do {
		let byte = Number(remaining & 127n);
		remaining >>= 7n;
		if (remaining) byte |= 128;
		bytes.push(byte);
	} while (remaining);
	return Buffer.from(bytes);
}
function fieldVarint$1(field, value) {
	return Buffer.concat([encodeVarint(field << 3), encodeVarint(value)]);
}
function fieldBytes(field, value) {
	return Buffer.concat([
		encodeVarint(field << 3 | 2),
		encodeVarint(value.length),
		Buffer.from(value)
	]);
}
function fieldStringValue(field, value) {
	return fieldBytes(field, Buffer.from(value));
}
/** 嵌套 map<string,string> 键值项：field { 1: key, 2: value } */
function kv(field, key, value) {
	return fieldBytes(field, Buffer.concat([fieldStringValue(1, key), fieldStringValue(2, value)]));
}

//#endregion
//#region src/core/im/protocol/ws.ts
/**
* Cookie 鉴权 Android Frontier WS 客户端底层（等价迁移自 android-ws.ts 的连接部分，
* 并参考 ws-client.ts 的连接生命周期）。
* 仅负责：连接、心跳、指数退避重连、帧字节分发；消息解析与发送属业务层。
* 不打印日志：正常重连等事件全部通过回调通知，由上层决定记录策略。
*/
const ANDROID_FRONTIER = "wss://frontier-aweme-lf-ipainner.amemv.com/ws/v2";
const ANDROID_APP_KEY = "e1bd35ec9db7b8d846de66ed140b1ad9";
const ANDROID_ACCESS_SALT = "f8a69f1719916z";
const ANDROID_UA = "okhttp/3.12.1 com.ss.android.ugc.aweme/280400";
const ANDROID_SDK_VERSION = "5.0.3.0-rc.11-SNAPSHOT";
function buildAndroidFrontierUrl(userId, now = Date.now()) {
	const accessKey = createHash("md5").update(`9${ANDROID_APP_KEY}${userId}${ANDROID_ACCESS_SALT}`).digest("hex");
	const params = new URLSearchParams({
		aid: "1128",
		fpid: "9",
		sdk_version: "3",
		device_id: userId,
		iid: userId,
		access_key: accessKey,
		pl: "0",
		ne: "1",
		version_code: "280400",
		version_name: "28.4.0",
		update_version_code: "28409900",
		platform: "0",
		monitor_service_id_list: "[]",
		is_background: "0",
		"ping-interval": "30",
		qos_level: "2",
		qos_sdk_version: "2",
		ttnet_ignore_offline: "1",
		ws_connect_protocol: "0",
		device_platform: "android",
		os: "android",
		app_name: "aweme",
		package: "com.ss.android.ugc.aweme",
		channel: "douyinweb1_64",
		ac: "wifi",
		language: "zh",
		device_type: "24031PN0DC",
		device_brand: "XIAOMI",
		os_api: "34",
		os_version: "14",
		ts: String(Math.floor(now / 1e3)),
		_rticket: String(Math.floor(now / 1e3) * 1e3)
	});
	return `${ANDROID_FRONTIER}?${params}`;
}
/** 指数退避：1s, 2s, 4s, ... 封顶 30s */
function reconnectDelay(attempt) {
	return Math.min(3e4, 1e3 * 2 ** Math.max(0, attempt - 1));
}
function cookieValue(cookies, name) {
	const entry = cookies.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
	if (!entry) return undefined;
	const value = entry.slice(name.length + 1);
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}
function toBytes(data) {
	return Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
}
/** Android Frontier WS：连接 / 15s 心跳 / 指数退避重连 / 帧分发 */
var AndroidFrontierWs = class {
	options;
	socket;
	heartbeat;
	reconnectTimer;
	connectTask;
	reconnectAttempt = 0;
	stopped = true;
	hasConnected = false;
	constructor(options) {
		this.options = options;
	}
	get connected() {
		return this.socket?.readyState === WebSocket.OPEN;
	}
	connect() {
		if (this.connected) return Promise.resolve();
		if (this.connectTask) return this.connectTask;
		this.stopped = false;
		const task = this.openSocket();
		this.connectTask = task;
		void task.then(() => this.clearConnectTask(task), () => this.clearConnectTask(task));
		return task;
	}
	close() {
		this.stopped = true;
		this.hasConnected = false;
		this.reconnectAttempt = 0;
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		delete this.reconnectTimer;
		this.stopHeartbeat();
		this.socket?.close();
		delete this.socket;
	}
	openSocket() {
		return new Promise((resolve, reject) => {
			const url = buildAndroidFrontierUrl(this.options.userId);
			const socket = this.createSocket(url, this.buildHeaders());
			this.socket = socket;
			let opened = false;
			let settled = false;
			const fail = (error) => {
				if (settled) return;
				settled = true;
				reject(error);
			};
			socket.once("error", fail);
			socket.once("unexpected-response", (_req, res) => {
				const msg = String(res.headers["handshake-msg"] ?? "");
				logger.debug(`[douyin:ws] 握手失败 HTTP ${res.statusCode} ${msg}`);
				res.resume();
			});
			socket.once("open", () => {
				if (this.stopped) {
					socket.close();
					resolve();
					return;
				}
				opened = true;
				settled = true;
				socket.off("error", fail);
				this.reconnectAttempt = 0;
				this.hasConnected = true;
				logger.debug(`[douyin:ws] 已连接 ${url.slice(0, 80)}...`);
				this.heartbeat = setInterval(() => {
					if (socket.readyState === WebSocket.OPEN) socket.ping();
				}, 15e3);
				this.options.callbacks?.onOpen?.();
				resolve();
			});
			socket.on("message", (data) => {
				const bytes = toBytes(data);
				logger.debug(`[douyin:ws] 收到帧 ${bytes.length}B`);
				this.options.callbacks?.onMessage?.(bytes);
			});
			socket.on("close", (code, reason) => {
				this.stopHeartbeat();
				if (this.socket === socket) delete this.socket;
				const text = reason.toString();
				if (!opened) fail(new Error(`WebSocket closed before open: code=${code} reason=${text}`));
				this.options.callbacks?.onClose?.({
					code,
					reason: text
				});
				if (!this.stopped && this.hasConnected) this.scheduleReconnect(code, text);
			});
			socket.on("error", (error) => {
				logger.debug(`[douyin:ws] 连接错误: ${error.message}`);
				this.options.callbacks?.onError?.(error);
			});
		});
	}
	createSocket(url, headers) {
		const socketOptions = {
			headers,
			handshakeTimeout: 3e4
		};
		return this.options.webSocketFactory ? this.options.webSocketFactory(url, ["pbbp2"], socketOptions) : new WebSocket(url, ["pbbp2"], socketOptions);
	}
	/**
	* 一次性连接发送帧并等待响应提取（Android cmd=100 直发）。
	* 返回 undefined 表示超时/连接失败/未匹配到响应。
	*/
	async sendOnce(frame, extract, ackTimeoutMs = 4e3) {
		return new Promise((resolve) => {
			const url = buildAndroidFrontierUrl(this.options.userId);
			const socket = this.createSocket(url, this.buildHeaders());
			let settled = false;
			let ackTimer;
			const finish = (result) => {
				if (settled) return;
				settled = true;
				if (ackTimer) clearTimeout(ackTimer);
				clearTimeout(connectTimer);
				socket.off("message", onMessage);
				try {
					if (socket.readyState === WebSocket.OPEN) socket.close();
					else if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
				} catch {}
				resolve(result);
			};
			const onMessage = (data) => {
				const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
				const result = extract(bytes);
				if (result !== undefined) finish(result);
			};
			socket.once("open", () => {
				ackTimer = setTimeout(() => finish(undefined), ackTimeoutMs);
				socket.send(frame, (error) => {
					if (error) finish(undefined);
				});
			});
			socket.on("message", onMessage);
			socket.once("close", () => finish(undefined));
			socket.once("error", () => finish(undefined));
			const connectTimer = setTimeout(() => finish(undefined), 3e4);
		});
	}
	buildHeaders() {
		const headers = {
			"User-Agent": ANDROID_UA,
			Origin: "wss://frontier-aweme-lf-ipainner.amemv.com",
			Cookie: this.options.cookies,
			"x-support-qos2": "1",
			"x-support-ack": "1",
			"sdk-version": "2",
			"passport-sdk-version": "601504",
			"X-SS-DP": "1128",
			"x-tt-store-region": "cn",
			"x-tt-store-region-src": "uid",
			"x-bd-kmsv": "1"
		};
		const tlbTag = cookieValue(this.options.cookies, "session_tlb_tag");
		const mfaToken = cookieValue(this.options.cookies, "passport_mfa_token");
		if (tlbTag) headers["session-tlb-tag"] = tlbTag;
		if (mfaToken) headers["x-tt-passport-mfa-token"] = mfaToken;
		return headers;
	}
	scheduleReconnect(code, reason) {
		if (this.stopped || this.reconnectTimer) return;
		const attempt = ++this.reconnectAttempt;
		const delayMs = reconnectDelay(attempt);
		const event = {
			attempt,
			delayMs
		};
		if (code != null) event.code = code;
		if (reason) event.reason = reason;
		this.options.callbacks?.onReconnecting?.(event);
		this.reconnectTimer = setTimeout(() => {
			delete this.reconnectTimer;
			if (this.stopped) return;
			void this.openSocket().catch(() => this.scheduleReconnect());
		}, delayMs);
	}
	clearConnectTask(task) {
		if (this.connectTask === task) delete this.connectTask;
	}
	stopHeartbeat() {
		if (this.heartbeat) clearInterval(this.heartbeat);
		delete this.heartbeat;
	}
};

//#endregion
//#region src/core/im/transport.ts
/** 官方 PC 客户端 UA（媒体上传与 Cookie 通道共用） */
const DESKTOP_PC_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) douyin/8.5.302 Chrome/136.0.7103.59 Electron/36.4.0-rs.31.release.pgo.7 TTElectron/36.4.0-rs.31.release.pgo.7 Safari/537.36 awemePcClient/8.5.302 buildId/469548567 osName/Windows";
/** Desktop Cookie 通道 profile（对照官方 native ImOption；设备身份走 URL query 而非 envelope headers） */
const DESKTOP_IM_PROFILE = {
	appId: 339757,
	appName: "aweme_im_desktop",
	version: "1.2.1",
	buildNumber: "eb11b84dd0eb26ae22321b53426d3f976b920862",
	apiUrl: "https://imapi3-normal.zijieapi.com",
	access: "cpp_sdk",
	biz: "douyin_im_pc"
};
/** 官方桌面 IM 客户端 UA */
const DESKTOP_IM_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) douyinim/1.2.1 Chrome/130.0.6723.58 Electron/33.2.0 Safari/537.36";
/** config/v2 与 batch_play_info 共用的 desktop 指纹 query（媒体上传用）。 */
function desktopFingerprintParams(deviceId, guid) {
	return new URLSearchParams({
		aid: "339757",
		version_name: "1.1.33",
		version_code: "1.1.33",
		device_platform: "win32",
		os_version: "10.0.26200",
		screen_width: "1707",
		screen_height: "1067",
		browser_language: "zh-CN",
		browser_platform: "Win32",
		browser_name: "Mozilla",
		browser_version: DESKTOP_PC_UA.replace(/^Mozilla\//, ""),
		browser_online: "true",
		cookie_enabled: "true",
		device_id: deviceId,
		did: deviceId,
		iid: "0",
		awemeim_guid: guid,
		channel: "0"
	});
}
/** imapi envelope headers KV（Desktop Cookie 通道，对照官方 PC 客户端抓包形状）；HTTP 发送通道 f15 复用 */
function desktopEnvelopeHeaders(deviceId) {
	return {
		session_aid: "6383",
		session_did: deviceId,
		app_name: "douyin_pc",
		priority_region: "cn",
		user_agent: DESKTOP_PC_UA,
		cookie_enabled: "true",
		browser_language: "zh-CN",
		browser_platform: "Win32",
		browser_name: "Mozilla",
		browser_version: DESKTOP_PC_UA.replace(/^Mozilla\//, ""),
		browser_online: "true",
		referer: "https://www.douyin.com/",
		timezone_name: "Asia/Shanghai",
		"is-retry": "0"
	};
}
/** 官方桌面客户端 queryMap（设备身份载体；native ImOption.headersMap 为空） */
function desktopImQuery(deviceId) {
	return {
		aid: String(DESKTOP_IM_PROFILE.appId),
		app_name: DESKTOP_IM_PROFILE.appName,
		did: deviceId,
		device_id: deviceId,
		iid: "0",
		channel: "0",
		os_version: os.release(),
		version_code: DESKTOP_IM_PROFILE.version,
		version_name: DESKTOP_IM_PROFILE.version,
		device_platform: "windows",
		device_type: process.arch,
		device_brand: ""
	};
}
/**
* HTTP protobuf 通道：Desktop cookie 通道（发送/收件箱查询/动作/撤回/陌生人消息）
*/
var ImProtoTransport = class {
	http;
	constructor(http) {
		this.http = http;
	}
	/** Desktop Cookie 通道（native ImOption profile：设备身份在 URL query，envelope headers 为空）。 */
	async sendCookieProto(cmd, inboxType, endpoint, body, deviceId) {
		const payload = await encodeRequest({
			token: "",
			cmd,
			inboxType,
			body,
			authType: 1,
			deviceId,
			sdkVersion: DESKTOP_IM_PROFILE.version,
			buildNumber: DESKTOP_IM_PROFILE.buildNumber,
			versionCode: DESKTOP_IM_PROFILE.version,
			devicePlatform: "windows",
			biz: DESKTOP_IM_PROFILE.biz,
			access: DESKTOP_IM_PROFILE.access,
			headers: {}
		});
		const url = new URL(endpoint, DESKTOP_IM_PROFILE.apiUrl);
		for (const [key, value] of Object.entries(desktopImQuery(deviceId))) {
			url.searchParams.set(key, value);
		}
		const requestBody = Buffer.from(payload);
		const res = await this.http.requestBytes(url.toString(), {
			method: "POST",
			headers: {
				Accept: "x-protobuf",
				"Content-Type": "application/x-protobuf",
				"x-ss-stub": createHash("md5").update(requestBody).digest("hex"),
				"User-Agent": DESKTOP_IM_UA,
				Referer: "https://imdesktop.douyin.com"
			},
			body: requestBody
		});
		if (!res.ok) {
			throw new Error(`IM Cookie HTTP ${res.status} ${endpoint}: ${Buffer.from(res.data).toString("utf8", 0, 200)}`);
		}
		try {
			const decoded = await decodeResponseRaw(res.data);
			logEnvelope(cmd, endpoint, decoded);
			return decoded;
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new Error(`IM Cookie response decode failed cmd=${cmd} ${endpoint}: ${detail}`);
		}
	}
};
/** envelope 响应状态日志（失败 WARN，成功 debug） */
function logEnvelope(cmd, endpoint, decoded) {
	const statusCode = Number(decoded["statusCode"] ?? 0);
	if (statusCode !== 0) {
		logger.warn(`[douyin:im] cmd=${cmd} ${endpoint} 失败: statusCode=${statusCode} errorDesc=${String(decoded["errorDesc"] ?? "")}`);
		return;
	}
	logger.debug(`[douyin:im] cmd=${cmd} ${endpoint} ok`);
}

//#endregion
//#region src/core/im/inbox.ts
const LONG$1 = protobuf.util.Long;
function parseActionCheckMessage(value) {
	if (!value.trim()) return { parsed: false };
	try {
		const parsed = JSON.parse(value);
		const rawCode = parsed["status_code"] ?? parsed["statusCode"];
		const code = rawCode === undefined ? undefined : Number(rawCode);
		const message = [
			parsed["status_msg"],
			parsed["statusMsg"],
			parsed["tips"],
			parsed["toast"],
			parsed["message"]
		].map((item) => String(item ?? "")).find(Boolean);
		return {
			parsed: true,
			...code !== undefined && Number.isFinite(code) ? { code } : {},
			...message ? { message } : {}
		};
	} catch {
		return { parsed: false };
	}
}
/** Desktop Cookie 会话动作统一响应归一 */
function actionResponse(decoded, bodyKey) {
	const envelopeStatus = Number(decoded["statusCode"] ?? 0);
	const payload = decoded["body"];
	const body = bodyKey ? payload?.[bodyKey] : undefined;
	const actionStatus = Number(body?.status ?? 0);
	const checkMessage = String(body?.checkMessage ?? "");
	const checkDetail = parseActionCheckMessage(checkMessage);
	const checkCode = checkDetail.code ?? Number(body?.checkCode ?? 0);
	const statusCode = envelopeStatus || checkCode || actionStatus;
	const statusMsg = [
		checkDetail.message,
		checkDetail.parsed ? "" : checkMessage,
		body?.extraInfo,
		decoded["errorDesc"]
	].map((value) => String(value ?? "")).find(Boolean) ?? "";
	return {
		statusCode,
		statusMsg,
		...checkCode ? { checkCode } : {}
	};
}
/** cmd=705, /v1/message/set_property — 消息表情回应（operation 0=添加 1=移除） */
async function modifyReaction(ctx, deviceId, options) {
	const decoded = await ctx.transport.sendCookieProto(705, options.inboxType ?? 0, "/v1/message/set_property", { modifyMessageProperty: {
		propertyList: [{
			conversationId: options.conversationId,
			conversationType: options.conversationType ?? 1,
			conversationShortId: LONG$1.fromString(options.conversationShortId || "0"),
			serverMessageId: LONG$1.fromString(options.serverMessageId),
			clientMessageId: "",
			modifyPropertyContent: [{
				operation: options.enabled ? 0 : 1,
				key: `se:${options.emoji}`,
				value: "",
				idempotentId: options.operatorUid
			}]
		}],
		ticket: ""
	} }, deviceId);
	const envelopeStatus = Number(decoded["statusCode"] ?? 0);
	return {
		statusCode: envelopeStatus === 1 ? 0 : envelopeStatus,
		statusMsg: String(decoded["errorDesc"] ?? "")
	};
}
/** cmd=702, /v1/message/recall — 撤回已投递消息 */
async function recall$1(ctx, deviceId, options) {
	const decoded = await ctx.transport.sendCookieProto(702, options.inboxType ?? 0, "/v1/message/recall", { recallMessage: {
		conversationId: options.conversationId,
		conversationShortId: LONG$1.fromString(options.conversationShortId || "0"),
		conversationType: options.conversationType ?? 1,
		serverMessageId: LONG$1.fromString(options.serverMessageId)
	} }, deviceId);
	const envelopeStatus = Number(decoded["statusCode"] ?? 0);
	const body = decoded["body"];
	const recallBody = body?.["recallMessage"];
	const actionStatus = recallBody?.status ?? 0;
	return {
		statusCode: envelopeStatus || actionStatus,
		statusMsg: String(decoded["errorDesc"] ?? ""),
		recalled: envelopeStatus === 0 && actionStatus === 0
	};
}
/** cmd=2006, /v1/conversation/list — Desktop 群聊元数据列表。 */
async function listConversations(ctx, deviceId, options = {}) {
	const decoded = await ctx.transport.sendCookieProto(2006, 0, "/v1/conversation/list", { conversationList: {
		listType: 1,
		cursor: options.cursor ?? 0,
		sortType: 2,
		limit: options.count ?? 20
	} }, deviceId);
	const statusCode = Number(decoded["statusCode"] ?? 0);
	if (statusCode !== 0) throw new Error(`listConversations failed: ${String(decoded["errorDesc"] ?? "")} (code=${statusCode})`);
	const body = decoded["body"];
	const list = body?.["conversationList"];
	const conversations = list?.conversations ?? [];
	return conversations.map(mapProtoConversationListItem);
}
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
/** Desktop Cookie cmd=203。实测 inboxType=1 返回群聊及普通私信；不依赖 Creator IM token。 */
async function listCookieThreads(ctx, deviceId, options = {}) {
	const limit = options.count ?? 20;
	const cursor = options.cursor ?? 0;
	let lastError;
	for (let attempt = 0; attempt < 3; attempt++) {
		let decoded;
		try {
			decoded = await ctx.transport.sendCookieProto(203, options.inboxType ?? 1, "/v2/message/get_by_user_init", { inbox: {
				convLimit: limit,
				msgLimit: limit,
				cursor
			} }, deviceId);
		} catch (err) {
			lastError = err;
			await sleep(1e3);
			continue;
		}
		const statusCode = Number(decoded["statusCode"] ?? 0);
		if (statusCode !== 0) {
			lastError = new Error(`listCookieThreads failed: ${String(decoded["errorDesc"] ?? "")} (code=${statusCode})`);
			await sleep(1e3);
			continue;
		}
		const body = decoded["body"];
		const inbox = body?.["inbox"];
		const rawMessages = inbox?.messages ?? [];
		const rawConversations = inbox?.conversations ?? [];
		const threads = rawConversations.length > 0 ? rawConversations.map((conversation) => mapProtoConversationMeta(conversation, rawMessages, ctx.platformUid)) : dedupeThreads(rawMessages.map((message) => mapProtoConversation(message, ctx.platformUid)));
		return dedupeThreads(threads);
	}
	throw lastError instanceof Error ? lastError : new Error("listCookieThreads failed");
}
/** cmd=2047, /v1/message/get_recent_stranger_message — 陌生人消息（Desktop Cookie 通道，对齐 douyin-im ImStrangerApi） */
async function listStrangerThreads(ctx, options = {}) {
	const decoded = await ctx.transport.sendCookieProto(2047, 1, "/v1/message/get_recent_stranger_message", { getRecentStrangerMessage: {
		latestStrangerVersion: LONG$1.fromString("0"),
		earliestStrangerVersion: LONG$1.fromString("0"),
		source: "code_up",
		newUser: 0,
		bizInfo: ""
	} }, ctx.deviceId);
	const statusCode = Number(decoded["statusCode"] ?? 0);
	if (statusCode !== 0) {
		throw new Error(`listStrangerThreads failed: ${String(decoded["errorDesc"] ?? "")} (code=${statusCode})`);
	}
	const body = decoded["body"];
	const page = body?.["getRecentStrangerMessage"];
	const rows = page?.messages ?? [];
	const rawMessages = rows.flatMap((row) => row["messages"] ?? []);
	return dedupeThreads(rawMessages.map((message) => mapProtoConversation(message, ctx.platformUid)));
}
/** cmd=301, /v1/message/get_by_conversation — 会话历史消息（对齐 douyin-im ImInboxApi.getMessages） */
async function getChatHistory(ctx, deviceId, options) {
	const decoded = await ctx.transport.sendCookieProto(301, 1, "/v1/message/get_by_conversation", { conversationMessages: {
		conversationId: options.conversationId,
		conversationType: options.conversationType,
		conversationShortId: LONG$1.fromString(options.conversationShortId),
		direction: 1,
		anchorIndex: options.cursor ?? 0,
		limit: options.count ?? 20
	} }, deviceId);
	const statusCode = Number(decoded["statusCode"] ?? 0);
	if (statusCode !== 0) {
		throw new Error(`getChatHistory failed: ${String(decoded["errorDesc"] ?? "")} (code=${statusCode})`);
	}
	const body = decoded["body"];
	const cm = body?.["conversationMessages"];
	return (cm?.messages ?? []).map((m) => mapProtoMessage(m));
}
/** 好友列表：Desktop Cookie 会话（P2P）映射为好友信息 */
async function getFriendList$1(ctx, deviceId, options = {}) {
	const threads = await listCookieThreads(ctx, deviceId, options);
	return threads.filter((thread) => thread.conversationType === 1 || thread.conversationType === undefined).map(mapThreadToFriend).filter((friend) => friend != null);
}
/** 群列表：cmd 2006 会话中 type=2 / 纯数字会话 ID 的条目 */
async function getGroupList$1(ctx, deviceId, options = {}) {
	const conversations = await listConversations(ctx, deviceId, options);
	return conversations.filter((conversation) => conversation.isGroup);
}
/** 群成员列表：cmd=605 分页拉全量 */
async function getGroupMembers$1(ctx, deviceId, options) {
	const members = [];
	let cursor = "0";
	const seenCursors = new Set();
	for (;;) {
		if (seenCursors.has(cursor)) {
			throw new Error("participant cursor did not advance");
		}
		seenCursors.add(cursor);
		const decoded = await ctx.transport.sendCookieProto(605, options.inboxType ?? 0, "/v1/conversation/participants_list", { conversationParticipants: {
			conversationId: options.conversationId,
			conversationShortId: LONG$1.fromString(options.conversationShortId),
			conversationType: options.conversationType,
			cursor: LONG$1.fromString(cursor),
			limit: 100
		} }, deviceId);
		const result = actionResponse(decoded, "conversationParticipants");
		if (result.statusCode !== 0) throw new Error(`getGroupMembers failed: ${result.statusMsg} (code=${result.statusCode})`);
		const payload = decoded["body"];
		const body = payload?.["conversationParticipants"];
		const participantPage = body?.participantsPage;
		for (const participant of participantPage?.participants ?? []) {
			const uid = String(participant["userId"] ?? "");
			if (!uid) continue;
			const secUid = String(participant["secUid"] ?? "");
			const alias = String(participant["alias"] ?? "");
			const sortOrder = String(participant["sortOrder"] ?? "");
			const leftBlockTime = String(participant["leftBlockTime"] ?? "");
			const ext = participant["ext"];
			members.push({
				uid,
				role: Number(participant["role"] ?? 0),
				...secUid ? { secUid } : {},
				...alias ? { alias } : {},
				...sortOrder ? { sortOrder } : {},
				...participant["blocked"] !== undefined ? { blocked: Number(participant["blocked"]) } : {},
				...leftBlockTime ? { leftBlockTime } : {},
				...ext && typeof ext === "object" ? { ext } : {}
			});
		}
		if (!participantPage?.hasMore) return members;
		const nextCursor = String(participantPage.cursor ?? "");
		if (!nextCursor) throw new Error("participant cursor did not advance");
		cursor = nextCursor;
	}
}
/** 陌生人会话列表 */
async function getStrangerList$1(ctx, options = {}) {
	const threads = await listStrangerThreads(ctx, options);
	return threads.map(mapThreadToStranger).filter((stranger) => stranger != null);
}
function joinRequestData(value) {
	if (!value) return undefined;
	const requestId = String(value["applyId"] ?? "");
	const applicantUid = String(value["userId"] ?? "");
	const groupShortId = String(value["convShortId"] ?? "");
	if (!requestId || !applicantUid || !groupShortId) return undefined;
	const applicantSecUid = String(value["secUid"] ?? "");
	const reason = String(value["applyReason"] ?? "");
	const inviterUid = String(value["inviteUserId"] ?? "");
	const inviterSecUid = String(value["secInviteUid"] ?? "");
	const createdAt = String(value["createTime"] ?? "");
	const modifiedAt = String(value["modifyTime"] ?? "");
	const moderatorUid = String(value["modifyUser"] ?? "");
	const ext = value["ext"];
	return {
		requestId,
		applicantUid,
		groupShortId,
		conversationType: Number(value["conversationType"] ?? 2),
		status: Number(value["applyStatus"] ?? 1),
		...applicantSecUid ? { applicantSecUid } : {},
		...reason ? { reason } : {},
		...inviterUid && inviterUid !== "0" ? { inviterUid } : {},
		...inviterSecUid ? { inviterSecUid } : {},
		...createdAt && createdAt !== "0" ? { createdAt } : {},
		...modifiedAt && modifiedAt !== "0" ? { modifiedAt } : {},
		...moderatorUid && moderatorUid !== "0" ? { moderatorUid } : {},
		...ext && typeof ext === "object" ? { ext } : {}
	};
}
function friendRequestData(value) {
	if (!value) return undefined;
	const applicantUid = String(value["userId"] ?? "");
	if (!applicantUid || applicantUid === "0") return undefined;
	const profile = value["profile"];
	const ext = value["ext"];
	const extRecord = ext && typeof ext === "object" ? ext : undefined;
	const nickname = String(profile?.["nickName"] ?? "");
	const avatar = String(profile?.["protrait"] ?? "");
	const requestedAt = String(value["applyTimeSecond"] ?? "");
	const message = String(extRecord?.["apply_reason"] ?? extRecord?.["applyReason"] ?? extRecord?.["message"] ?? "");
	return {
		applicantUid,
		status: Number(value["status"] ?? 1),
		...nickname ? { nickname } : {},
		...avatar ? { avatar } : {},
		...requestedAt && requestedAt !== "0" ? { requestedAt } : {},
		...message ? { message } : {},
		...extRecord ? { ext: extRecord } : {}
	};
}
/** cmd=2027, /v1/conversation/get_audit_list — 入群申请列表 */
async function getGroupJoinRequests$1(ctx, deviceId, options = {}) {
	const requests = [];
	let cursor = "0";
	const seenCursors = new Set();
	for (;;) {
		if (seenCursors.has(cursor)) {
			throw new Error("join-request cursor did not advance");
		}
		seenCursors.add(cursor);
		const decoded = await ctx.transport.sendCookieProto(2027, 1, "/v1/conversation/get_audit_list", { getConversationAuditList: {
			cursor: LONG$1.fromString(cursor),
			limit: 100
		} }, deviceId);
		const result = actionResponse(decoded);
		if (result.statusCode !== 0) throw new Error(`getGroupJoinRequests failed: ${result.statusMsg} (code=${result.statusCode})`);
		const payload = decoded["body"];
		const body = payload?.["getConversationAuditList"];
		for (const raw of body?.applyInfoList ?? []) {
			const request = joinRequestData(raw);
			if (request && (!options.conversationShortId || request.groupShortId === options.conversationShortId)) {
				requests.push(request);
			}
		}
		if (!body?.hasMore) return requests;
		const nextCursor = String(body.nextCursor ?? "");
		if (!nextCursor) throw new Error("join-request cursor did not advance");
		cursor = nextCursor;
	}
}
/** cmd=902, /v1/conversation/set_conversation_core_info — 设置群名 */
async function setGroupName$1(ctx, deviceId, address, name) {
	const decoded = await ctx.transport.sendCookieProto(902, 1, "/v1/conversation/set_conversation_core_info", { setConversationCoreInfo: {
		conversationId: address.conversationId,
		conversationShortId: address.conversationShortId ? LONG$1.fromString(address.conversationShortId) : undefined,
		conversationType: address.conversationType,
		name,
		isNameSet: true
	} }, deviceId);
	return actionResponse(decoded, "setConversationCoreInfo");
}
/** cmd=2025, /v1/conversation/ack_apply — 审批入群申请 */
async function reviewGroupJoinRequest(ctx, deviceId, requestId, status) {
	if (!/^\d+$/.test(requestId)) throw new Error("join request id must be numeric");
	const decoded = await ctx.transport.sendCookieProto(2025, 1, "/v1/conversation/ack_apply", { ackConversationApply: {
		applyId: LONG$1.fromString(requestId),
		applyStatus: status,
		bizExt: {}
	} }, deviceId);
	const result = actionResponse(decoded, "ackConversationApply");
	const payload = decoded["body"];
	const body = payload?.["ackConversationApply"];
	const request = joinRequestData(body?.applyInfo);
	return {
		...result,
		...request ? { request } : {}
	};
}
/** cmd=20481, /v1/friend/get_receive_apply_list — 好友申请列表 */
async function getFriendRequests$1(ctx, deviceId, options = {}) {
	const requests = [];
	let cursor = "0";
	const seenCursors = new Set();
	for (;;) {
		if (seenCursors.has(cursor)) {
			throw new Error("friend-request cursor did not advance");
		}
		seenCursors.add(cursor);
		const decoded = await ctx.transport.sendCookieProto(20481, 0, "/v1/friend/get_receive_apply_list", { getFriendReceiveApplyList: {
			cursor: LONG$1.fromString(cursor),
			limit: LONG$1.fromString("100"),
			getTotalCount: true,
			status: options.status ?? 1
		} }, deviceId);
		const result = actionResponse(decoded);
		if (result.statusCode !== 0) throw new Error(`getFriendRequests failed: ${result.statusMsg} (code=${result.statusCode})`);
		const payload = decoded["body"];
		const body = payload?.["getFriendReceiveApplyList"];
		for (const raw of body?.userList ?? []) {
			const request = friendRequestData(raw);
			if (request) requests.push(request);
		}
		if (!body?.hasMore) return requests;
		const nextCursor = String(body.nextCursor ?? "");
		if (!nextCursor) throw new Error("friend-request cursor did not advance");
		cursor = nextCursor;
	}
}
/** cmd=2049, /v1/friend/reply_apply — 审批好友申请 */
async function reviewFriendRequest(ctx, deviceId, applicantUid, status) {
	if (!/^\d+$/.test(applicantUid)) throw new Error("friend request uid must be numeric");
	const decoded = await ctx.transport.sendCookieProto(2049, 0, "/v1/friend/reply_apply", { replyFriendApply: {
		userId: [LONG$1.fromString(applicantUid)],
		attitude: status,
		ext: {}
	} }, deviceId);
	return actionResponse(decoded, "replyFriendApply");
}

//#endregion
//#region src/core/im/send.ts
const LONG = protobuf.util.Long;
function encodeReference(reference) {
	return {
		referencedMessageId: LONG.fromString(reference.referencedMessageId),
		hint: reference.hint,
		...reference.rootMessageId ? { rootMessageId: LONG.fromString(reference.rootMessageId) } : {},
		...reference.rootMessageConvIndex ? { rootMessageConvIndex: LONG.fromString(reference.rootMessageConvIndex) } : {}
	};
}
/** cmd=100 /v1/message/send — 统一发送（文本/媒体/引用全走此路径） */
async function send(ctx, options) {
	const clientMessageId = randomUUID();
	const timestamp = Date.now();
	const decoded = await ctx.transport.sendCookieProto(100, options.inboxType ?? 0, "/v1/message/send", { sendMessage: {
		conversationId: options.conversationId,
		conversationType: options.conversationType ?? 1,
		conversationShortId: LONG.fromString(options.conversationShortId || "0"),
		content: normalizeDesktopTextMessageContent(options.content, options.messageType ?? 7),
		messageType: options.messageType ?? 7,
		clientMessageId,
		ext: {
			"s:mentioned_users": "",
			"s:client_message_id": clientMessageId,
			"s:stime": `${timestamp}.${String(timestamp % 1e4).padStart(4, "0")}`
		},
		...options.reference ? { refMsgInfo: encodeReference(options.reference) } : {},
		...options.mentionedUsers?.length ? { mentionedUsers: options.mentionedUsers.map((uid) => LONG.fromString(uid)) } : {}
	} }, ctx.deviceId);
	const result = parseSendResponse(decoded, clientMessageId);
	if (result.checkCode === 10502) {
		logger.info("[douyin:im] 消息已提交，审核中（10502），对方可能延迟可见");
	} else if (result.statusCode !== 0) {
		logger.warn(`[douyin:im] 发送被拒: conversationId=${options.conversationId} ` + `statusCode=${result.statusCode} check=${result.checkCode ?? "-"} detail=${result.statusMsg}`);
	}
	return result;
}
/** 发送文本（可带 @ 提及：content richTextInfos + mentionedUsers 字段） */
async function sendText$1(ctx, address, text, mentions) {
	return send(ctx, {
		...address,
		content: mentions?.length ? buildDesktopTextContent(text, mentions) : text,
		messageType: 7,
		...mentions?.length ? { mentionedUsers: [...new Set(mentions.map((m) => m.uid))] } : {}
	});
}
/** 节点文本摘要：文字原样，媒体占位（list_content.text） */
function nodeSummaryText(message) {
	return message.map((el) => {
		if (el.type === "text") return el.text ?? "";
		if (el.type === "image") return "[图片]";
		if (el.type === "video") return "[视频]";
		if (el.type === "record") return "[语音]";
		return `[${el.type}]`;
	}).join("");
}
/** 节点消息类型：文本 7/700，图片 27/2702，其余按文本处理 */
function nodeMessageType(message) {
	const first = message[0]?.type;
	if (first === "image") return {
		msgType: 27,
		aweType: 2702
	};
	return {
		msgType: 7,
		aweType: 700
	};
}
/**
* 合并转发（messageType=136）：list_content 为节点摘要，msg_ids 为节点引用。
* 服务端按收到的同形内容渲染，msg_id 用客户端生成的数字串。
*/
async function sendMergeForward(ctx, options) {
	if (!options.nodes.length) throw new Error("合并转发节点为空");
	const timestamp = Date.now();
	const listContent = options.nodes.map((node) => ({
		text: node.text,
		msgid: node.msgId,
		nick_name: node.nickname
	}));
	const msgIds = options.nodes.map((node) => ({
		msg_id: node.msgId,
		msg_type: node.msgType,
		awe_type: node.aweType,
		show_flag: true,
		uid: Number(node.uid),
		...node.secUid ? { sec_uid: node.secUid } : {},
		create_time: node.createTime ?? timestamp,
		ref_msg_invisible: 0
	}));
	return send(ctx, {
		...options,
		content: JSON.stringify({
			list_content: listContent,
			msg_ids: msgIds
		}),
		messageType: 136
	});
}
/** karin node fake 节点 → ForwardNode（客户端生成 19 位数字 msg_id） */
function buildForwardNodes(nodes, selfUid, selfSecUid) {
	const timestamp = Date.now();
	return nodes.map((node, index) => {
		const { msgType, aweType } = nodeMessageType(node.message);
		return {
			uid: /^\d+$/.test(node.userId) ? node.userId : selfUid,
			nickname: node.nickname || "",
			text: nodeSummaryText(node.message),
			msgType,
			aweType,
			msgId: String(BigInt(timestamp) * 1000n + BigInt(index)),
			...node.userId === selfUid && selfSecUid ? { secUid: selfSecUid } : {},
			createTime: timestamp
		};
	});
}
/** 发送图片（gif → aweType 2703，其余 2702；messageType=27） */
async function sendImage$1(ctx, options) {
	return send(ctx, {
		...options,
		content: buildImageContent(options.image),
		messageType: 27
	});
}
/** 发送视频（messageType=30，content 无 aweType） */
async function sendVideo$1(ctx, options) {
	return send(ctx, {
		...options,
		content: buildVideoContent(options.video),
		messageType: 30
	});
}
/** 发送文件（messageType=6，aweType=15001） */
async function sendFile$1(ctx, options) {
	return send(ctx, {
		...options,
		content: buildFileContent(options.file),
		messageType: 6
	});
}
/** 引用回复：正文 desktop 文本模板 + refMsgInfo（cmd100 field 11） */
async function reply$1(ctx, options) {
	const payload = buildReplyPayload({
		text: options.text,
		referencedMessageId: options.referencedMessageId,
		referencedMessageType: options.referencedMessageType,
		referencedUid: options.referencedUid,
		...options.referencedSecUid ? { referencedSecUid: options.referencedSecUid } : {},
		...options.nickname ? { nickname: options.nickname } : {},
		...options.referencedText ? { referencedText: options.referencedText } : {},
		...options.rootMessageId ? { rootMessageId: options.rootMessageId } : {},
		...options.rootMessageConvIndex ? { rootMessageConvIndex: options.rootMessageConvIndex } : {}
	});
	return send(ctx, {
		...options,
		content: payload.content,
		messageType: 7,
		reference: payload.reference
	});
}
/** body.sendMessageBody 解析：serverMessageId/status/checkCode/checkMessage */
function parseSendResponse(decoded, clientMessageId) {
	const statusCode = Number(decoded["statusCode"] ?? 0);
	const body = decoded["body"];
	const sendBody = body?.["sendMessage"];
	const rawCheckCode = Number(sendBody?.checkCode ?? 0);
	let checkCode = rawCheckCode > 0 ? rawCheckCode : undefined;
	let checkTips = "";
	if (sendBody?.checkMessage) {
		try {
			const check = JSON.parse(sendBody.checkMessage);
			if (Number(check.status_code) > 0) checkCode = Number(check.status_code);
			checkTips = String(check.tips ?? "");
		} catch {}
	}
	const sendStatus = Number(sendBody?.status ?? 0);
	const serverMessageId = sendBody?.serverMessageId != null ? String(sendBody.serverMessageId) : undefined;
	const envelopeMsg = String(decoded["errorDesc"] ?? "");
	const delivered = statusCode === 0 && sendStatus === 0 && !!serverMessageId && serverMessageId !== "0";
	if (!delivered) {
		return {
			statusCode: statusCode || sendStatus || -1,
			statusMsg: checkTips || envelopeMsg || "send rejected",
			clientMessageId,
			...checkCode !== undefined ? { checkCode } : {}
		};
	}
	return {
		statusCode: 0,
		statusMsg: envelopeMsg,
		serverMessageId,
		clientMessageId: sendBody?.clientMessageId ?? clientMessageId,
		...checkCode !== undefined ? { checkCode } : {}
	};
}

//#endregion
//#region src/core/im/media.ts
function pickImageUrl(image) {
	return [
		image.originUrls,
		image.largeUrls,
		image.mediumUrls,
		image.thumbUrls
	].flatMap((urls) => urls).find(Boolean);
}
/** 解密抖音 iv(12) + ciphertext + GCM tag(16) 的图片容器 */
function decryptImage(encrypted, skeyHex) {
	const key = Buffer.from(skeyHex, "hex");
	if (key.length !== 32 || skeyHex.length !== 64) {
		throw new Error("image skey must be 32 bytes encoded as 64 hex characters");
	}
	if (encrypted.length < 28) throw new Error("encrypted image is too short");
	const input = Buffer.from(encrypted);
	const iv = input.subarray(0, 12);
	const tag = input.subarray(input.length - 16);
	const ciphertext = input.subarray(12, input.length - 16);
	const decipher = createDecipheriv("aes-256-gcm", key, iv);
	decipher.setAuthTag(tag);
	return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
/**
* 解密单个 cenc-aes-ctr sample。受保护子区共享同一条连续计数器流；
* clear 区间不消耗计数流。
*/
function decryptCencSample(data, keyInput, ivInput, subsamples = []) {
	const key = Buffer.from(keyInput);
	if (key.length !== 16) throw new Error("CENC key must be 16 bytes");
	if (ivInput.length !== 8 && ivInput.length !== 16) throw new Error("CENC IV must be 8 or 16 bytes");
	const iv = Buffer.alloc(16);
	Buffer.from(ivInput).copy(iv);
	const source = Buffer.from(data);
	if (subsamples.length === 0) {
		const cipher = createCipheriv("aes-128-ctr", key, iv);
		return Buffer.concat([cipher.update(source), cipher.final()]);
	}
	const protectedChunks = [];
	let pos = 0;
	for (const sample of subsamples) {
		if (sample.clear < 0 || sample.protected < 0 || pos + sample.clear + sample.protected > source.length) {
			throw new Error("CENC subsample exceeds sample bounds");
		}
		pos += sample.clear;
		protectedChunks.push(source.subarray(pos, pos + sample.protected));
		pos += sample.protected;
	}
	const cipher = createCipheriv("aes-128-ctr", key, iv);
	const decrypted = Buffer.concat([cipher.update(Buffer.concat(protectedChunks)), cipher.final()]);
	const output = Buffer.alloc(source.length);
	pos = 0;
	let decryptedPos = 0;
	for (const sample of subsamples) {
		source.copy(output, pos, pos, pos + sample.clear);
		pos += sample.clear;
		decrypted.copy(output, pos, decryptedPos, decryptedPos + sample.protected);
		pos += sample.protected;
		decryptedPos += sample.protected;
	}
	source.copy(output, pos, pos);
	return output;
}
function sniffImageFormat(data) {
	const b = Buffer.from(data);
	if (b.length >= 12 && b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP") return "webp";
	if (b.length >= 2 && b[0] === 255 && b[1] === 216) return "jpeg";
	if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([
		137,
		80,
		78,
		71,
		13,
		10,
		26,
		10
	]))) return "png";
	if (b.length >= 6 && (b.subarray(0, 6).toString() === "GIF87a" || b.subarray(0, 6).toString() === "GIF89a")) return "gif";
	if (b.length >= 12 && b.subarray(4, 8).toString() === "ftyp") {
		const brands = new Set([
			"heic",
			"heix",
			"hevc",
			"hevx",
			"heim",
			"heis",
			"mif1",
			"msf1"
		]);
		for (let offset = 8; offset + 4 <= Math.min(b.length, 32); offset += 4) {
			if (brands.has(b.subarray(offset, offset + 4).toString())) return "heic";
		}
	}
	return "unknown";
}

//#endregion
//#region src/core/im/upload.ts
const UPLOAD_CONFIG_URL = "https://www.douyin.com/aweme/v1/web/im/upload/config/v2";
const VOD_URL = "https://vod.bytedanceapi.com/";
const VOD_REGION = "cn-north-1";
const VOD_SERVICE = "vod";
const VIDEO_PART_SIZE = 5 * 1024 * 1024;
function uploadProcessFunctions(fileType, imageFormat) {
	if (fileType === "object") return [];
	if (fileType === "video") {
		return [{
			name: "Encryption",
			input: {
				Config: {
					copies: "cipher_v2",
					aes_chunk_size: "524288"
				},
				PolicyParams: { "policy-set": "medium" }
			}
		}];
	}
	return [{
		name: "Encryption",
		input: {
			Config: { copies: "cipher_v2" },
			PolicyParams: imageFormat === "gif" ? {
				"policy-set": "still",
				"still-width": "480",
				"still-height": "480"
			} : { "policy-set": "check,thumb,medium,large" }
		}
	}];
}
function hashHex(data) {
	return createHash("sha256").update(data).digest("hex");
}
function hmac(key, value) {
	return createHmac("sha256", key).update(value).digest();
}
function rfc3986(value) {
	return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}
function canonicalUploadQuery(query) {
	return Object.keys(query).sort().map((key) => `${rfc3986(key)}=${rfc3986(query[key])}`).join("&");
}
/** ByteDance VOD 上传用的纯 AWS Signature V4 实现 */
function signVodRequest(options) {
	const canonicalQuery = canonicalUploadQuery(options.query);
	const amzDate = options.date.toISOString().replace(/[:-]|\.\d{3}/g, "");
	const dateStamp = amzDate.slice(0, 8);
	const payloadHash = hashHex(options.body ?? new Uint8Array());
	const headers = {
		"x-amz-date": amzDate,
		"x-amz-security-token": options.credentials.sessionToken
	};
	if (options.method === "POST") headers["x-amz-content-sha256"] = payloadHash;
	const headerNames = Object.keys(headers).sort();
	const canonicalHeaders = headerNames.map((name) => `${name}:${headers[name]}\n`).join("");
	const signedHeaders = headerNames.join(";");
	const canonicalRequest = [
		options.method,
		"/",
		canonicalQuery,
		canonicalHeaders,
		signedHeaders,
		payloadHash
	].join("\n");
	const scope = `${dateStamp}/${VOD_REGION}/${VOD_SERVICE}/aws4_request`;
	const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${hashHex(canonicalRequest)}`;
	let signingKey = hmac(`AWS4${options.credentials.secretAccessKey}`, dateStamp);
	signingKey = hmac(signingKey, VOD_REGION);
	signingKey = hmac(signingKey, VOD_SERVICE);
	signingKey = hmac(signingKey, "aws4_request");
	const signature = hmac(signingKey, stringToSign).toString("hex");
	return {
		canonicalQuery,
		headers,
		authorization: `AWS4-HMAC-SHA256 Credential=${options.credentials.accessKeyId}/${scope}, ` + `SignedHeaders=${signedHeaders}, Signature=${signature}`
	};
}
let crcTable;
function table() {
	if (crcTable) return crcTable;
	crcTable = new Uint32Array(256);
	for (let n = 0; n < 256; n += 1) {
		let c = n;
		for (let k = 0; k < 8; k += 1) c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;
		crcTable[n] = c >>> 0;
	}
	return crcTable;
}
function crc32Hex(data) {
	let crc = 4294967295;
	const values = table();
	for (const byte of data) crc = values[(crc ^ byte) & 255] ^ crc >>> 8;
	return ((crc ^ 4294967295) >>> 0).toString(16).padStart(8, "0");
}
function randomId(length) {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
	return [...randomBytes(length)].map((byte) => alphabet[byte % alphabet.length]).join("");
}
function imageDimensions(data) {
	const b = Buffer.from(data);
	if (b.length >= 24 && b.subarray(1, 4).toString() === "PNG") {
		return {
			width: b.readUInt32BE(16),
			height: b.readUInt32BE(20)
		};
	}
	if (b.length > 4 && b[0] === 255 && b[1] === 216) {
		let pos = 2;
		while (pos + 9 < b.length) {
			if (b[pos] !== 255) {
				pos += 1;
				continue;
			}
			const marker = b[pos + 1];
			if (marker >= 192 && marker <= 195) {
				return {
					width: b.readUInt16BE(pos + 7),
					height: b.readUInt16BE(pos + 5)
				};
			}
			const size = b.readUInt16BE(pos + 2);
			if (size < 2) break;
			pos += 2 + size;
		}
	}
	if (b.length >= 10 && (b.subarray(0, 6).toString() === "GIF87a" || b.subarray(0, 6).toString() === "GIF89a")) {
		return {
			width: b.readUInt16LE(6),
			height: b.readUInt16LE(8)
		};
	}
	return {
		width: 0,
		height: 0
	};
}
function asRecord$1(value) {
	return value && typeof value === "object" ? value : {};
}
/** Cookie 鉴权 STS → 签名 VOD → TOS 上传工作流（HTTP 统一经 DouyinHttp） */
var ImMediaUploader = class {
	http;
	resolveUserId;
	constructor(http, resolveUserId) {
		this.http = http;
		this.resolveUserId = resolveUserId;
	}
	async uploadImage(data) {
		if (data.length === 0) throw new Error("cannot upload an empty image");
		const format = sniffImageFormat(data);
		if (format === "unknown") throw new Error("unsupported image data");
		const credentials = await this.credentials();
		const address = await this.apply(credentials, credentials.spaceName, "image", data.length);
		await this.putObject(address, data);
		const committed = await this.commit(credentials, address.sessionKey, "image", format);
		const size = imageDimensions(data);
		return {
			oid: committed.uri,
			skey: committed.secretKey,
			md5: committed.sourceMd5,
			dataSize: committed.imageSize ?? data.length,
			width: committed.imageWidth ?? size.width,
			height: committed.imageHeight ?? size.height,
			format
		};
	}
	async uploadVideo(data) {
		if (data.length === 0) throw new Error("cannot upload an empty video");
		const credentials = await this.credentials();
		const address = await this.apply(credentials, credentials.spaceName, "video", data.length);
		const uploadId = await this.initParts(address);
		const parts = [];
		for (let offset = 0, part = 1; offset < data.length; offset += VIDEO_PART_SIZE, part += 1) {
			const chunk = data.slice(offset, Math.min(offset + VIDEO_PART_SIZE, data.length));
			const crc = crc32Hex(chunk);
			await this.transferPart(address, uploadId, part, crc, chunk);
			parts.push(`${part}:${crc}`);
		}
		await this.finishParts(address, uploadId, parts.join(","));
		const committed = await this.commit(credentials, address.sessionKey, "video");
		return {
			tkey: committed.uri,
			skey: committed.secretKey,
			md5: committed.sourceMd5
		};
	}
	/** 文件上传（object 通道：public_file_config + GCM 服务端加密，≤10MiB） */
	async uploadFile(data, name) {
		if (!name.trim() || data.length === 0 || data.length > 10 * 1024 * 1024) {
			throw new Error("file requires a name and 1 byte to 10 MiB of data");
		}
		const credentials = await this.credentials("public_file_config");
		const address = await this.apply(credentials, credentials.spaceName, "object", data.length);
		await this.putObject(address, data);
		const committed = await this.commit(credentials, address.sessionKey, "object", undefined, address);
		return {
			uri: committed.uri,
			skey: committed.secretKey,
			md5: committed.sourceMd5,
			name,
			dataSize: data.length
		};
	}
	async credentials(configKey = "public_image_config") {
		const deviceId = await this.resolveUserId();
		const params = desktopFingerprintParams(deviceId, randomBytes(16).toString("hex"));
		const response = await this.http.requestRaw(`${UPLOAD_CONFIG_URL}?${params}`, {
			method: "GET",
			headers: { Referer: "https://www.douyin.com/" }
		});
		const json = asRecord$1(JSON.parse(response.rawText));
		const config = asRecord$1(json[configKey]);
		const credentials = {
			accessKeyId: String(config["access_key_id"] ?? ""),
			secretAccessKey: String(config["secret_access_key"] ?? ""),
			sessionToken: String(config["session_token"] ?? ""),
			spaceName: String(config["space_name"] ?? "")
		};
		if (!response.ok || !credentials.accessKeyId || !credentials.secretAccessKey || !credentials.spaceName) {
			throw new Error(`upload credentials unavailable (HTTP ${response.status})`);
		}
		return credentials;
	}
	async apply(credentials, space, fileType, fileSize) {
		const query = {
			Action: "ApplyUploadInner",
			Version: "2020-11-19",
			SpaceName: space,
			FileType: fileType,
			IsInner: "1",
			NeedFallback: "true",
			FileSize: String(fileSize),
			s: randomId(11),
			...fileType === "object" ? { OpenGcmEnc: "true" } : {}
		};
		const json = await this.signedVodJson("GET", query, undefined, credentials);
		const result = asRecord$1(json["Result"]);
		const direct = asRecord$1(result["UploadAddress"]);
		const directStores = direct["StoreInfos"];
		const directHosts = direct["UploadHosts"];
		const inner = asRecord$1(result["InnerUploadAddress"]);
		const nodes = inner["UploadNodes"];
		if (!nodes?.length && directStores?.length && directHosts?.length && fileType !== "object") {
			const store = asRecord$1(directStores[0]);
			return {
				storeUri: String(store["StoreUri"] ?? ""),
				authorization: String(store["Auth"] ?? ""),
				host: String(directHosts[0]),
				sessionKey: String(direct["SessionKey"] ?? "")
			};
		}
		const node = asRecord$1(nodes?.[0]);
		const stores = node["StoreInfos"];
		const store = asRecord$1(stores?.[0]);
		const address = {
			storeUri: String(store["StoreUri"] ?? ""),
			authorization: String(store["Auth"] ?? ""),
			host: String(node["UploadHost"] ?? ""),
			sessionKey: String(node["SessionKey"] ?? ""),
			uploadHeaders: Object.fromEntries(Object.entries(asRecord$1(node["UploadHeader"])).map(([key, value]) => [key, String(value)]))
		};
		if (fileType === "object") {
			address.gcmMode = String(asRecord$1(result["SDKParam"])["server_gcm_encryption_mode"] ?? "");
			address.encryptionKey = String(asRecord$1(inner["AdvanceOption"])["EncryptionKey"] ?? "");
			if (!address.gcmMode || !address.encryptionKey) throw new Error("VOD apply response missing file GCM parameters");
		}
		if (!address.storeUri || !address.authorization || !address.host || !address.sessionKey) {
			throw new Error("VOD apply response did not contain an upload address");
		}
		return address;
	}
	async putObject(address, data) {
		const response = await this.http.requestRaw(`https://${address.host}/upload/v1/${address.storeUri}`, {
			method: "POST",
			headers: {
				...await this.storageHeaders(address.authorization, crc32Hex(data)),
				...address.uploadHeaders ?? {},
				...address.gcmMode ? {
					"X-Upload-Server-Gcm-Encryption-Mode": address.gcmMode,
					"X-Upload-Server-Gcm-Encryption-Key": address.encryptionKey ?? ""
				} : {}
			},
			body: new Uint8Array(data)
		});
		const result = asRecord$1(JSON.parse(response.rawText));
		if (!response.ok || Number(result["code"]) !== 2e3) {
			throw new Error(`TOS upload failed: ${result["message"] ?? response.status}`);
		}
	}
	async initParts(address) {
		const boundary = `----WebKitFormBoundary${randomId(16)}`;
		const response = await this.http.requestRaw(`https://${address.host}/upload/v1/${address.storeUri}?phase=init`, {
			method: "POST",
			headers: {
				...await this.storageHeaders(address.authorization),
				"Content-Type": `multipart/form-data; boundary=${boundary}`
			},
			body: `--${boundary}--\r\n`
		});
		const result = asRecord$1(JSON.parse(response.rawText));
		const uploadId = String(asRecord$1(result["data"])["uploadid"] ?? "");
		if (!response.ok || Number(result["code"]) !== 2e3 || !uploadId) throw new Error("TOS multipart init failed");
		return uploadId;
	}
	async transferPart(address, uploadId, part, crc, data) {
		const query = new URLSearchParams({
			uploadid: uploadId,
			part_number: String(part),
			phase: "transfer"
		});
		const response = await this.http.requestRaw(`https://${address.host}/upload/v1/${address.storeUri}?${query}`, {
			method: "POST",
			headers: {
				...await this.storageHeaders(address.authorization, crc),
				"Content-Disposition": "attachment; filename=\"undefined\""
			},
			body: new Uint8Array(data)
		});
		const result = asRecord$1(JSON.parse(response.rawText));
		if (!response.ok || Number(result["code"]) !== 2e3) throw new Error(`TOS part ${part} failed`);
	}
	async finishParts(address, uploadId, manifest) {
		const query = new URLSearchParams({
			phase: "finish",
			uploadid: uploadId
		});
		const response = await this.http.requestRaw(`https://${address.host}/upload/v1/${address.storeUri}?${query}`, {
			method: "POST",
			headers: {
				...await this.storageHeaders(address.authorization),
				"Content-Type": "text/plain;charset=UTF-8"
			},
			body: manifest
		});
		const result = asRecord$1(JSON.parse(response.rawText));
		if (!response.ok || Number(result["code"]) !== 2e3) throw new Error("TOS multipart finish failed");
	}
	async commit(credentials, sessionKey, fileType, imageFormat, address) {
		const body = Buffer.from(JSON.stringify({
			SessionKey: sessionKey,
			Functions: uploadProcessFunctions(fileType, imageFormat),
			...address?.gcmMode ? {
				EncryptionMode: address.gcmMode,
				EncryptionKey: address.encryptionKey
			} : {}
		}));
		const json = await this.signedVodJson("POST", {
			Action: "CommitUploadInner",
			Version: "2020-11-19",
			SpaceName: credentials.spaceName
		}, body, credentials);
		const results = asRecord$1(json["Result"])["Results"];
		const encryption = asRecord$1(asRecord$1(results?.[0])["Encryption"]);
		const extra = asRecord$1(encryption["Extra"]);
		const committed = {
			uri: String(encryption["Uri"] ?? ""),
			secretKey: String(encryption["SecretKey"] ?? ""),
			sourceMd5: String(encryption["SourceMd5"] ?? "")
		};
		const imageSize = Number(extra["img_size"]);
		const imageWidth = Number(extra["img_width"]);
		const imageHeight = Number(extra["img_height"]);
		if (Number.isFinite(imageSize) && imageSize > 0) committed.imageSize = imageSize;
		if (Number.isFinite(imageWidth) && imageWidth > 0) committed.imageWidth = imageWidth;
		if (Number.isFinite(imageHeight) && imageHeight > 0) committed.imageHeight = imageHeight;
		if (!committed.uri || !committed.secretKey) throw new Error("VOD commit response did not contain encryption metadata");
		return committed;
	}
	async signedVodJson(method, query, body, credentials) {
		const signed = signVodRequest({
			method,
			query,
			...body ? { body } : {},
			credentials,
			date: new Date()
		});
		const response = await this.http.requestRaw(`${VOD_URL}?${signed.canonicalQuery}`, {
			method,
			headers: {
				...signed.headers,
				Authorization: signed.authorization,
				"User-Agent": DESKTOP_PC_UA,
				...body ? { "Content-Type": "text/plain;charset=UTF-8" } : {}
			},
			...body ? { body: new Uint8Array(body) } : {}
		});
		const json = asRecord$1(JSON.parse(response.rawText));
		if (!response.ok) throw new Error(`VOD ${method} failed (HTTP ${response.status})`);
		const error = asRecord$1(asRecord$1(json["ResponseMetadata"])["Error"]);
		if (error["Code"] || error["CodeN"]) {
			throw new Error(`VOD ${query["Action"]} failed: ${String(error["Code"] ?? error["CodeN"])}`);
		}
		return json;
	}
	async storageHeaders(authorization, crc) {
		const headers = {
			Authorization: authorization,
			"Content-Type": "application/octet-stream",
			"X-Storage-U": await this.resolveUserId(),
			"User-Agent": DESKTOP_PC_UA
		};
		if (crc) headers["Content-CRC32"] = crc;
		return headers;
	}
};

//#endregion
//#region src/core/im/notifications.ts
const COMMAND_MESSAGE_TYPES = new Set([
	40001,
	50001,
	50002,
	50003,
	50004,
	50005,
	50010,
	50011,
	50012,
	50013,
	50014,
	50015,
	50016,
	50017,
	60001,
	70001,
	70002,
	80001,
	80002,
	80003,
	80004,
	80005,
	90001,
	90002
]);
const GROUP_MEMBER_INCREASE_TYPES = new Map([
	[100100, "invite"],
	[100101, "command"],
	[100102, "qrcode"],
	[100107, "duoshan"],
	[100109, "apply"],
	[100111, "search"],
	[100112, "activity"],
	[100113, "face-to-face"],
	[100114, "circle"]
]);
const GROUP_MEMBER_DECREASE_TYPES = new Map([[100104, "kick"], [100105, "leave"]]);
function fieldString(fields, number) {
	for (const field of fields) {
		if (field.field === number && field.type === "varint") return field.value.toString();
		if (field.field === number && field.type === "string") return field.value;
	}
	return undefined;
}
function messageChildren(fields, number) {
	return fields.filter((field) => field.field === number && field.type === "message").map((field) => field.value);
}
function collectKeyValues(fields, number) {
	const values = new Map();
	for (const child of messageChildren(fields, number)) {
		const key = fieldString(child, 1);
		const value = fieldString(child, 2);
		if (key && value != null) values.set(key, value);
	}
	return values;
}
function asRecord(value) {
	return typeof value === "object" && value !== null ? value : undefined;
}
function firstString(record, keys) {
	for (const key of keys) {
		const value = record?.[key];
		if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
			const text = String(value);
			if (text && text !== "0") return text;
		}
	}
	return undefined;
}
function commandPayload(content) {
	try {
		return asRecord(JSON.parse(content));
	} catch {
		return undefined;
	}
}
function noticeUsers(value) {
	if (!Array.isArray(value)) return [];
	const users = [];
	for (const item of value) {
		const user = asRecord(item);
		const uid = firstString(user, [
			"uid",
			"user_id",
			"userId"
		]);
		if (!uid) continue;
		const secUid = firstString(user, [
			"sec_uid",
			"secUid",
			"sec_user_id",
			"secUserId"
		]);
		const nickname = firstString(user, [
			"nickname",
			"nick_name",
			"display_name",
			"displayName"
		]);
		users.push({
			uid,
			...secUid ? { secUid } : {},
			...nickname ? { nickname } : {}
		});
	}
	return users;
}
function groupMemberIncreaseFromPush(push, payload) {
	if (push.conversationType !== 2 || !payload) return undefined;
	const aweType = Number(payload["aweType"] ?? payload["awe_type"] ?? 0);
	const source = GROUP_MEMBER_INCREASE_TYPES.get(aweType);
	if (!source) return undefined;
	const members = noticeUsers(payload["passive_users"] ?? payload["passiveUsers"]);
	if (members.length === 0) return undefined;
	return {
		type: "group.member-increase",
		conversationId: push.conversationId,
		conversationShortId: push.conversationShortId || push.conversationId,
		conversationType: 2,
		source,
		members,
		operators: noticeUsers(payload["active_users"] ?? payload["activeUsers"]),
		raw: push.raw
	};
}
function groupMemberDecreaseFromPush(push, payload) {
	if (push.conversationType !== 2 || !payload) return undefined;
	const aweType = Number(payload["aweType"] ?? payload["awe_type"] ?? 0);
	const source = GROUP_MEMBER_DECREASE_TYPES.get(aweType);
	if (!source) return undefined;
	const activeUsers = noticeUsers(payload["active_users"] ?? payload["activeUsers"]);
	const passiveUsers = noticeUsers(payload["passive_users"] ?? payload["passiveUsers"]);
	const members = source === "leave" ? activeUsers : passiveUsers;
	if (members.length === 0) return undefined;
	return {
		type: "group.member-decrease",
		conversationId: push.conversationId,
		conversationShortId: push.conversationShortId || push.conversationId,
		conversationType: 2,
		source,
		members,
		operators: source === "leave" ? [] : activeUsers,
		raw: push.raw
	};
}
function groupMetadataNoticeFromPush(push, payload) {
	if (push.conversationType !== 2 || !payload) return undefined;
	const aweType = Number(payload["aweType"] ?? payload["awe_type"] ?? 0);
	const base = {
		conversationId: push.conversationId,
		conversationShortId: push.conversationShortId || push.conversationId,
		conversationType: 2,
		operators: noticeUsers(payload["active_users"] ?? payload["activeUsers"]),
		raw: push.raw
	};
	if (aweType === 100110) {
		const members = noticeUsers(payload["passive_users"] ?? payload["passiveUsers"]);
		if (members.length === 0) return undefined;
		return {
			type: "group.admin",
			...base,
			members,
			enabled: true
		};
	}
	if (aweType === 100106) {
		const name = firstString(payload, [
			"new_name",
			"newName",
			"conversation_name",
			"conversationName",
			"name"
		]);
		return {
			type: "group.name-change",
			...base,
			...name ? { name } : {}
		};
	}
	if (aweType === 100115) {
		const avatar = firstString(payload, [
			"new_avatar",
			"newAvatar",
			"avatar_url",
			"avatarUrl",
			"avatar"
		]);
		return {
			type: "group.avatar-change",
			...base,
			...avatar ? { avatar } : {}
		};
	}
	return undefined;
}
/** 把 cmd500 中的协议命令消息与用户可见消息分流为 Notice 或 Request。 */
function noticeFromPush(push) {
	const payload = commandPayload(push.content);
	const groupIncrease = groupMemberIncreaseFromPush(push, payload);
	if (groupIncrease) return groupIncrease;
	const groupDecrease = groupMemberDecreaseFromPush(push, payload);
	if (groupDecrease) return groupDecrease;
	const groupMetadata = groupMetadataNoticeFromPush(push, payload);
	if (groupMetadata) return groupMetadata;
	if (!COMMAND_MESSAGE_TYPES.has(push.messageType)) return undefined;
	if (push.messageType === 40001) {
		const serverMessageId = firstString(payload, [
			"server_message_id",
			"serverMessageId",
			"message_id",
			"messageId"
		]);
		return {
			type: "message.recall",
			conversationId: push.conversationId,
			conversationType: push.conversationType,
			...serverMessageId ? { serverMessageId } : {},
			raw: push.raw
		};
	}
	if (push.messageType === 50005) {
		return {
			type: "conversation.delete",
			conversationId: push.conversationId,
			conversationType: push.conversationType,
			raw: push.raw
		};
	}
	if (push.messageType === 90001) {
		const apply = asRecord(payload?.["apply_info"] ?? payload?.["applyInfo"]);
		const groupShortId = firstString(apply ?? payload, [
			"conv_short_id",
			"convShortId",
			"conversation_short_id",
			"conversationShortId"
		]);
		const requestId = firstString(apply ?? payload, [
			"apply_id",
			"applyId",
			"request_id",
			"requestId"
		]);
		return {
			type: "group.join-request",
			conversationId: push.conversationId,
			conversationShortId: groupShortId || push.conversationShortId || push.conversationId,
			conversationType: push.conversationType,
			...requestId ? { requestId } : {},
			content: push.content,
			raw: push.raw
		};
	}
	return {
		type: "im.command",
		conversationId: push.conversationId,
		conversationType: push.conversationType,
		messageType: push.messageType,
		content: push.content,
		raw: push.raw
	};
}
/** Android Frontier 原生通知/请求事件（501 已读、502 会话更新、507 好友事件） */
function extractAndroidNotices(payload) {
	const top = decodeWire(payload);
	const tree = decodeWireTree(payload);
	const envelopes = messageChildren(top, 8);
	if (messageChildren(top, 6).length > 0) envelopes.push(top);
	const notices = [];
	for (const envelope of envelopes) {
		for (const body of messageChildren(envelope, 6)) {
			for (const read of messageChildren(body, 501)) {
				notices.push({
					type: "conversation.read",
					conversationId: fieldString(read, 1) ?? "",
					conversationType: Number(fieldString(read, 2) ?? 0),
					readMessageIndex: fieldString(read, 3) ?? "0",
					readMessageIndexV2: fieldString(read, 4) ?? "0",
					raw: {
						transport: "android-frontier",
						wireTree: tree
					}
				});
			}
			for (const updated of messageChildren(body, 502)) {
				for (const conversation of messageChildren(updated, 1)) {
					notices.push({
						type: "conversation.update",
						conversationId: fieldString(conversation, 1) ?? "",
						conversationType: Number(fieldString(conversation, 3) ?? 0),
						raw: {
							transport: "android-frontier",
							wireTree: tree
						}
					});
				}
			}
			for (const friend of messageChildren(body, 507)) {
				const messageType = Number(fieldString(friend, 1) ?? 0);
				const fromUid = fieldString(friend, 2) ?? "";
				const toUid = fieldString(friend, 3) ?? "";
				const peerUid = fromUid || toUid;
				const content = fieldString(friend, 4);
				if (messageType === 1 && peerUid) {
					notices.push({
						type: "friend.request",
						applicantUid: peerUid,
						...fromUid ? { fromUid } : {},
						...toUid ? { toUid } : {},
						...content ? { content } : {},
						raw: {
							transport: "android-frontier",
							wireTree: tree
						}
					});
				} else if ((messageType === 2 || messageType === 3) && peerUid) {
					notices.push({
						type: messageType === 3 ? "friend.increase" : "friend.decrease",
						peerUid,
						...fromUid ? { fromUid } : {},
						...toUid ? { toUid } : {},
						...content ? { content } : {},
						raw: {
							transport: "android-frontier",
							wireTree: tree
						}
					});
				}
			}
		}
	}
	return notices;
}

//#endregion
//#region src/core/im/receiver.ts
/** 原始推送 → 业务入站消息（附加解析内容与展示文本） */
function toInboundMessage(push) {
	const parsed = parseMessageContent(push.content, push.messageType);
	if (parsed.kind === "unknown") {
		logger.debug(`[douyin:im] 未识别消息: cmd=${push.cmd} messageType=${push.messageType ?? "-"} ` + `conversationId=${push.conversationId} content=${push.content.slice(0, 600)}`);
	}
	return {
		...push,
		parsed,
		text: displayText(push.content, push.messageType)
	};
}
/**
* 无 schema 提取嵌套引用信息（同 cmd=100 refMsgInfo 同构字段序）：
* field 1 = referencedMessageId（int64 → varint），field 2 = hint JSON（含 refmsg_type 等键），field 3 = rootMessageId
*/
function extractReference(fields) {
	for (const field of fields) {
		if (field.type !== "message") continue;
		const hint = field.value.find((item) => item.type === "string" && item.value.includes("refmsg_type"))?.value;
		if (!hint) continue;
		const varint = (num) => {
			const hit = field.value.find((item) => item.type === "varint" && item.field === num)?.value;
			return hit !== undefined ? hit.toString() : undefined;
		};
		const refId = varint(1) ?? field.value.find((item) => item.type === "string" && /^\d{10,}$/.test(item.value))?.value;
		if (!refId) continue;
		const rootMessageId = varint(3);
		return {
			referencedMessageId: refId,
			hint,
			...rootMessageId ? { rootMessageId } : {}
		};
	}
	return undefined;
}
function collectMessages(fields, output, rawTree, inherited = {}) {
	const strings = fields.filter((item) => item.type === "string").map((item) => ({
		field: item.field,
		value: item.value
	}));
	const context = { ...inherited };
	const envelopeCmd = fieldString(fields, 1);
	const envelopeInboxType = fieldString(fields, 5);
	if (envelopeCmd && envelopeInboxType && (envelopeInboxType === "0" || envelopeInboxType === "1")) {
		context.cmd = Number(envelopeCmd);
		context.inboxType = Number(envelopeInboxType);
	}
	const conversationId = strings.find(({ value }) => /^0:1:\d+:\d+$/.test(value))?.value ?? strings.find(({ field, value }) => field === 1 && /^\d+$/.test(value))?.value;
	if (conversationId) context.conversationId = conversationId;
	const senderUid = fieldString(fields, 7);
	if (senderUid && senderUid.length >= 15 && /^\d+$/.test(senderUid)) context.senderUid = senderUid;
	const senderSecUid = fieldString(fields, 14);
	if (senderSecUid?.startsWith("MS4")) context.senderSecUid = senderSecUid;
	const shortId = fieldString(fields, 5);
	if ((conversationId || senderUid) && shortId && /^\d+$/.test(shortId)) context.conversationShortId = shortId;
	const serverMessageId = fieldString(fields, 3);
	if ((conversationId || senderUid) && serverMessageId && /^\d+$/.test(serverMessageId)) context.serverMessageId = serverMessageId;
	const indexInConversation = fieldString(fields, 4);
	if ((conversationId || senderUid) && indexInConversation) context.indexInConversation = indexInConversation;
	const indexInConversationV2 = fieldString(fields, 17);
	if ((conversationId || senderUid) && indexInConversationV2) context.indexInConversationV2 = indexInConversationV2;
	const createTime = fieldString(fields, 10);
	if ((conversationId || senderUid) && createTime) context.createTime = createTime;
	const reference = extractReference(fields);
	if ((conversationId || senderUid) && reference) context.reference = reference;
	const contentField = fields.find((item) => item.type === "string" && (item.field === 8 || item.field === 6) && item.value.trimStart().startsWith("{"));
	if (context.conversationId && context.senderUid && contentField) {
		output.push({
			cmd: context.cmd ?? 500,
			...context.inboxType !== undefined ? { inboxType: context.inboxType } : {},
			conversationId: context.conversationId,
			conversationShortId: context.conversationShortId ?? "",
			conversationType: /^\d+$/.test(context.conversationId) ? 2 : 1,
			senderUid: context.senderUid,
			...context.senderSecUid ? { senderSecUid: context.senderSecUid } : {},
			content: contentField.value,
			messageType: Number(fieldString(fields, 6) ?? 7),
			...context.serverMessageId ? { serverMessageId: context.serverMessageId } : {},
			...context.indexInConversation ? { indexInConversation: context.indexInConversation } : {},
			...context.indexInConversationV2 ? { indexInConversationV2: context.indexInConversationV2 } : {},
			...context.createTime ? { createTime: context.createTime } : {},
			...context.reference ? { reference: context.reference } : {},
			raw: {
				transport: "android-frontier",
				content: contentField.value,
				wireTree: rawTree
			}
		});
	}
	for (const field of fields) {
		if (field.type === "message") collectMessages(field.value, output, rawTree, context);
	}
}
/** Android Frontier payload 的无 schema 消息提取 */
function extractAndroidPushes(payload) {
	const output = [];
	const fields = decodeWire(payload);
	const tree = decodeWireTree(payload);
	collectMessages(fields, output, tree);
	const unique = new Map();
	for (const message of output) {
		unique.set(`${message.serverMessageId ?? ""}|${message.conversationId}|${message.senderUid}|${message.content}`, message);
	}
	return [...unique.values()];
}
/** varint 字段值（bigint → string） */
function fieldVarint(fields, field) {
	const hit = fields.find((item) => item.type === "varint" && item.field === field)?.value;
	return hit?.toString();
}
/**
* cmd=500 field=500 property 推送 → 消息表情回应（ModifyPropertyBody 同构下发）：
* f1=conversation_id, f2=conversation_type, f3=conversation_short_id, f4=server_message_id,
* f5=client_message_id, f6=repeated ModifyPropertyContent{operation=1,key=2,value=3,idempotent_id=4}
*/
function extractReactions(payload) {
	const events = [];
	const visit = (fields) => {
		for (const item of fields) {
			if (item.type === "message") visit(item.value);
			if (item.type !== "message" || item.field !== 500) continue;
			for (const body of item.value.filter((inner) => inner.type === "message" && inner.field === 5)) {
				const list = body.value;
				const conversationId = list.find((inner) => inner.type === "string" && inner.field === 1)?.value;
				const bigId = (field) => {
					const value = fieldVarint(list, field);
					return value && value.length >= 18 ? value : undefined;
				};
				const serverMessageId = bigId(4) ?? bigId(3);
				if (!conversationId || !serverMessageId) continue;
				for (const content of list.filter((inner) => inner.type === "message" && inner.field === 6)) {
					const inner = content.value;
					const operation = Number(fieldVarint(inner, 1) ?? "0");
					const rawKey = inner.find((el) => el.type === "string" && el.field === 2)?.value;
					const operatorUid = inner.find((el) => el.type === "string" && el.field === 4)?.value;
					if (!rawKey || !rawKey.includes(":")) continue;
					events.push({
						type: "message.reaction",
						conversationId,
						serverMessageId,
						emoji: rawKey.replace(/^se:/, ""),
						operatorUid: operatorUid ?? "",
						isSet: operation === 0,
						raw: {}
					});
				}
			}
		}
	};
	visit(decodeWire(payload));
	return events;
}

//#endregion
//#region src/core/im/client.ts
/**
* IM 消息业务门面：收消息走 Android Frontier WS 推送，
* 发消息统一 HTTP cookie 通道（native ImOption profile，cmd=100），
* HTTP 同时承担收件箱查询/动作与媒体上传。方法直接转发到各模块。
*/
var ImClient = class {
	options;
	http;
	userId;
	cookies;
	deviceId;
	transport;
	uploader;
	inboxCtx;
	/** Android Frontier 长连接：接收推送 */
	ws;
	handlers = new Map();
	constructor(options) {
		this.options = options;
		this.http = options.http;
		this.userId = options.userId;
		this.cookies = options.cookies;
		this.deviceId = options.deviceId ?? "";
		this.transport = new ImProtoTransport(this.http);
		this.uploader = new ImMediaUploader(this.http, async () => this.userId);
		this.ws = new AndroidFrontierWs({
			userId: options.userId,
			cookies: options.cookies,
			callbacks: {
				onMessage: (bytes) => this.handleFrame(bytes),
				onReconnecting: (event) => this.emit("reconnecting", event),
				onClose: (event) => this.emit("close", event)
			}
		});
		this.inboxCtx = {
			transport: this.transport,
			deviceId: this.deviceId,
			platformUid: options.userId
		};
	}
	/** 连接 Android Frontier WS 长连接并开始接收群聊/私聊消息 */
	async start() {
		if (this.ws.connected) return;
		await this.ws.connect();
	}
	/** 停止接收并关闭连接 */
	stop() {
		this.ws.close();
	}
	/** 事件注册：message / notice / request / reconnecting / close（start 前注册同样生效） */
	on(event, callback) {
		let set = this.handlers.get(event);
		if (!set) {
			set = new Set();
			this.handlers.set(event, set);
		}
		set.add(callback);
	}
	off(event, callback) {
		this.handlers.get(event)?.delete(callback);
	}
	emit(event, ...args) {
		for (const handler of this.handlers.get(event) ?? []) {
			handler(...args);
		}
	}
	/** Android Frontier 帧分发：原生通知/请求 + 消息推送（过滤自发，命令消息分流为 notice/request） */
	handleFrame(bytes) {
		for (const notice of extractAndroidNotices(bytes)) {
			if (notice.type === "friend.request" || notice.type === "group.join-request") {
				this.emit("request", notice);
			} else {
				this.emit("notice", notice);
			}
		}
		const pushes = extractAndroidPushes(bytes);
		let emitted = 0;
		for (const reaction of extractReactions(bytes)) {
			this.emit("notice", reaction);
			emitted++;
		}
		for (const push of pushes) {
			if (push.senderUid === this.userId) continue;
			if (push.messageType >= 5e4) continue;
			const event = noticeFromPush(push);
			if (event) {
				if (event.type === "friend.request" || event.type === "group.join-request") {
					this.emit("request", event);
				} else {
					this.emit("notice", event);
				}
				emitted++;
				continue;
			}
			this.emit("message", toInboundMessage(push));
			emitted++;
		}
		if (emitted === 0) {
			const wire = JSON.stringify(decodeWireTree(bytes));
			const len = wire.includes("\"f\":500") ? 3800 : 0;
			if (len && /0:\d+:\d+:\d+/.test(wire)) {
				logger.debug(`[douyin:im] property帧无产出 ${bytes.length}B wire=${wire.slice(0, len)}`);
			}
		}
	}
	/**
	* 发送全部走 Android Frontier WS cmd=100 直发
	* （ext 携带 s:send_ignore_ticket=true，无需会话 ticket 与设备真值）。
	*/
	async sendText(address, text, mentions) {
		return sendText$1(this.sendCtx(), address, text, mentions);
	}
	/** 合并转发（messageType=136） */
	async sendMergeForward(options) {
		return sendMergeForward(this.sendCtx(), options);
	}
	/** 发送图片/视频/文件（媒体需先 uploadImage/uploadVideo/uploadFile） */
	async sendMedia(item) {
		const ctx = this.sendCtx();
		if (item.image) return sendImage$1(ctx, {
			...item,
			image: item.image
		});
		if (item.video) {
			const { asset, poster, width, height, checkPics } = item.video;
			return sendVideo$1(ctx, {
				...item,
				video: {
					tkey: asset.tkey,
					skey: asset.skey,
					md5: asset.md5,
					poster,
					width,
					height,
					...checkPics ? { checkPics } : {}
				}
			});
		}
		if (item.file) return sendFile$1(ctx, {
			...item,
			file: item.file
		});
		return Promise.reject(new Error("sendMedia requires image, video or file"));
	}
	async reply(options) {
		return reply$1(this.sendCtx(), options);
	}
	recall(item) {
		return recall$1(this.inboxCtx, this.deviceId, item);
	}
	/** 消息表情回应（cmd=705 set_property，emoji 为抖音 skey 文本键） */
	modifyReaction(item) {
		return modifyReaction(this.inboxCtx, this.deviceId, item);
	}
	uploadImage(data) {
		return this.uploader.uploadImage(data);
	}
	uploadVideo(data) {
		return this.uploader.uploadVideo(data);
	}
	uploadFile(data, name) {
		return this.uploader.uploadFile(data, name);
	}
	getFriendList(options = {}) {
		return getFriendList$1(this.inboxCtx, this.deviceId, options);
	}
	getGroupList(options = {}) {
		return getGroupList$1(this.inboxCtx, this.deviceId, options);
	}
	getGroupMembers(address) {
		return getGroupMembers$1(this.inboxCtx, this.deviceId, address);
	}
	getStrangerList(options = {}) {
		return getStrangerList$1(this.inboxCtx, options);
	}
	getChatHistory(address) {
		return getChatHistory(this.inboxCtx, this.deviceId, address);
	}
	getFriendRequests(options = {}) {
		return getFriendRequests$1(this.inboxCtx, this.deviceId, options);
	}
	getGroupJoinRequests(options = {}) {
		return getGroupJoinRequests$1(this.inboxCtx, this.deviceId, options);
	}
	approveFriend(applicantUid) {
		return reviewFriendRequest(this.inboxCtx, this.deviceId, applicantUid, 2);
	}
	rejectFriend(applicantUid) {
		return reviewFriendRequest(this.inboxCtx, this.deviceId, applicantUid, 3);
	}
	approveGroupJoin(requestId) {
		return reviewGroupJoinRequest(this.inboxCtx, this.deviceId, requestId, 2);
	}
	rejectGroupJoin(requestId) {
		return reviewGroupJoinRequest(this.inboxCtx, this.deviceId, requestId, 3);
	}
	/** 设置群名（cmd=902） */
	setGroupName(address, name) {
		return setGroupName$1(this.inboxCtx, this.deviceId, address, name);
	}
	/** 统一发送上下文：HTTP cookie 通道（native ImOption profile） */
	sendCtx() {
		return {
			transport: this.transport,
			deviceId: this.deviceId
		};
	}
};

//#endregion
//#region src/utils/config.ts
/** 默认配置 */
const defConfig = {
	accounts: [{
		name: "主号",
		enable: true
	}],
	receiverMode: "android_websocket",
	skipMssdk: true
};
/**
* @description 初始化配置文件
*/
copyConfigSync(dir.defConfigDir, dir.ConfigDir, [".json"]);
/**
* @description 读取配置
*/
const config = () => {
	try {
		const cfg = requireFileSync(`${dir.ConfigDir}/config.json`);
		return {
			...defConfig,
			...cfg
		};
	} catch {
		return defConfig;
	}
};
/**
* @description 监听配置文件
*/
setTimeout(() => {
	const list = filesByExt(dir.ConfigDir, ".json", "abs");
	list.forEach((file) => watch(file, (old, now) => {
		logger.info([
			"[douyin] 检测到配置文件更新",
			`旧数据: ${old}`,
			`新数据: ${now}`
		].join("\n"));
	}));
}, 2e3);

//#endregion
//#region src/api/account.ts
/** 构建适配器级账号管理器 */
function createAccountManager() {
	const store = new AccountStore({ accountsDir: dir.accountsDir });
	const accounts = new Map();
	const build = (platformUid, session, name) => {
		const http = new DouyinHttp({ initialCookies: session.cookies });
		if (session.msToken) http.setMsToken(session.msToken);
		const client = new ImClient({
			http,
			userId: platformUid,
			cookies: session.cookies,
			deviceId: session.deviceId ?? store.ensureDeviceId(platformUid)
		});
		return {
			platformUid,
			config: { name },
			http,
			client
		};
	};
	const recordName = (record) => {
		const name = record?.screenName ?? String(record?.userData?.screen_name ?? "");
		return name || undefined;
	};
	const persist = async (session, device) => {
		const prev = store.load(session.platformUid);
		const deviceId = device?.deviceId ?? prev?.session.deviceId ?? store.ensureDeviceId(session.platformUid);
		const screenName = String(session.userData?.screen_name ?? "") || prev?.screenName;
		store.save(session.platformUid, {
			platformUid: session.platformUid,
			session: {
				cookies: session.cookies,
				deviceId,
				verifiedAt: new Date().toISOString()
			},
			...session.userData ? { userData: session.userData } : {},
			...screenName ? { screenName } : {},
			...prev?.ticketGuard ? { ticketGuard: prev.ticketGuard } : {},
			...device ? { deviceProfile: device } : {},
			createdAt: prev?.createdAt ?? new Date().toISOString(),
			updatedAt: new Date().toISOString()
		});
	};
	const restore = async () => {
		const disabled = new Set(config().accounts.filter((a) => a.enable === false).map((a) => a.name ?? ""));
		for (const record of store.list()) {
			if (!record.session.cookies?.trim()) continue;
			if (disabled.has(record.platformUid) || disabled.has(String(record.userData?.name ?? ""))) continue;
			const numericUid = record.userData?.user_id_str;
			const platformUid = numericUid ?? record.platformUid;
			const deviceId = store.ensureDeviceId(record.platformUid);
			const acc = build(platformUid, {
				...record.session,
				deviceId
			}, recordName(record));
			accounts.set(platformUid, acc);
			await runPassportWarmup(acc.http).catch(() => undefined);
		}
	};
	const loginByQr = async (options = {}) => {
		const http = new DouyinHttp({ userAgent: DESKTOP_LOGIN_USER_AGENT });
		const device = await setupDesktopDevice(join(dir.accountsDir, "device.json"), http).catch(() => undefined);
		await desktopTtwidCheck(http).catch(() => undefined);
		let session;
		if (options.onQr) {
			const info = await getQrcode(http);
			options.onQr(info);
			session = await pollQrConfirm(http, info.token, options);
		} else {
			session = await loginByQrcode(http, options);
		}
		await fetchDesktopSelfProfile(http).then((profile) => {
			session.userData = {
				...session.userData,
				...profile.nickname ? { screen_name: profile.nickname } : {},
				...profile.avatar ? { avatar_url: profile.avatar } : {}
			};
		}).catch(() => undefined);
		await persist(session, device);
		const record = store.load(session.platformUid);
		const acc = build(session.platformUid, { cookies: session.cookies }, recordName(record));
		accounts.set(session.platformUid, acc);
		return acc;
	};
	const logout = (platformUid) => {
		accounts.get(platformUid)?.client.stop();
		accounts.delete(platformUid);
		store.remove(platformUid);
	};
	return {
		store,
		accounts,
		restore,
		loginByQr,
		logout
	};
}

//#endregion
//#region src/api/message.ts
/** 发送文本（可带 @ 提及） */
async function sendText(client, address, text, mentions) {
	return client.sendText(address, text, mentions);
}
/** 合并转发（136）：nodes 已构造（fake 节点由 buildForwardNodes 转换） */
async function sendForwardNodes(client, address, nodes, selfUid, selfSecUid) {
	return client.sendMergeForward({
		...address,
		nodes,
		selfUid,
		...selfSecUid ? { selfSecUid } : {}
	});
}
/** 发送图片：data 为原始字节（已上传前的 Buffer/Uint8Array） */
async function sendImage(client, address, data) {
	const asset = await client.uploadImage(data);
	return client.sendMedia({
		...address,
		image: asset
	});
}
/** 发送视频 */
async function sendVideo(client, address, data, poster, width, height) {
	const asset = await client.uploadVideo(data);
	const posterAsset = await client.uploadImage(poster);
	return client.sendMedia({
		...address,
		video: {
			asset,
			poster: posterAsset,
			width,
			height
		}
	});
}
/** 发送文件：data 为原始字节，name 为文件名（≤10MiB） */
async function sendFile(client, address, data, name) {
	const asset = await client.uploadFile(data, name);
	return client.sendMedia({
		...address,
		file: asset
	});
}
/** 引用回复（cmd=100 + refMsgInfo，引用信息已补全） */
async function reply(client, options) {
	return client.reply(options);
}
/** 撤回 */
async function recall(client, address, messageId) {
	return client.recall({
		...address,
		serverMessageId: messageId
	});
}
/** 历史消息（cursor = indexInConversation 游标，0 表示最新） */
async function getHistory(client, address, options = {}) {
	return client.getChatHistory({
		...address,
		...options
	});
}

//#endregion
//#region src/api/contact.ts
/** 好友列表 */
function getFriendList(client) {
	return client.getFriendList();
}
/** 群列表 */
function getGroupList(client) {
	return client.getGroupList();
}
/** 群成员 */
function getGroupMembers(client, address) {
	return client.getGroupMembers(address);
}
/** 陌生人会话列表 */
function getStrangerList(client) {
	return client.getStrangerList();
}
/** 依据好友 uid 解析会话地址（供发送/历史用） */
async function resolveFriendAddress(client, uid) {
	const list = await client.getFriendList();
	const friend = list.find((f) => f.uid === uid || f.conversationShortId === uid);
	if (!friend) return undefined;
	return {
		conversationId: friend.conversationId,
		conversationShortId: friend.conversationShortId,
		conversationType: 1
	};
}
/** 依据群 id/名解析会话地址 */
async function resolveGroupAddress(client, id) {
	const list = await client.getGroupList();
	const group = list.find((g) => g.conversationId === id || g.conversationShortId === id || g.name === id);
	if (!group) return undefined;
	return {
		conversationId: group.conversationId,
		conversationShortId: group.conversationShortId,
		conversationType: 2
	};
}
/** 设置群名（cmd=902） */
function setGroupName(client, address, name) {
	return client.setGroupName(address, name);
}

//#endregion
//#region src/api/request.ts
/** 待处理好友申请 */
function getFriendRequests(client) {
	return client.getFriendRequests();
}
/** 待处理入群申请 */
function getGroupJoinRequests(client, conversationShortId) {
	return client.getGroupJoinRequests({ ...conversationShortId ? { conversationShortId } : {} });
}
/** 同意好友申请 */
function approveFriend(client, uid) {
	return client.approveFriend(uid);
}
/** 拒绝好友申请 */
function rejectFriend(client, uid) {
	return client.rejectFriend(uid);
}
/** 同意入群申请 */
function approveGroupJoin(client, requestId) {
	return client.approveGroupJoin(requestId);
}
/** 拒绝入群申请 */
function rejectGroupJoin(client, requestId) {
	return client.rejectGroupJoin(requestId);
}

//#endregion
//#region src/adapter/convert.ts
/** 合并转发节点缓存：resId（消息 ID）→ 节点，getForwardMsg 供插件拉取 */
const forwardCache = new Map();
/** 读取合并转发节点缓存 */
function loadForwardNodes(resId) {
	return forwardCache.get(resId);
}
function cacheForwardNodes(resId, nodes) {
	forwardCache.set(resId, nodes);
	if (forwardCache.size > 200) {
		const first = forwardCache.keys().next().value;
		if (first) forwardCache.delete(first);
	}
}
/** 入站抖音消息 → karin Elements 数组 */
function toKarinElements(message) {
	const p = message.parsed;
	switch (p.kind) {
		case "text":
			if (message.reference) {
				const body = p.text ? [segment.text(p.text)] : [];
				return [segment.reply(message.reference.referencedMessageId), ...body];
			}
			return [segment.text(p.text)];
		case "emoji": return [segment.text(p.text || "[表情]")];
		case "image": {
			const url = pickImageUrl(p.image);
			return url ? [segment.image(url)] : [segment.text(p.text || "[图片]")];
		}
		case "video": {
			const poster = p.video.poster ? pickImageUrl(p.video.poster) : undefined;
			const parts = [];
			if (poster) parts.push(segment.image(poster));
			parts.push(segment.text(p.text || "[视频]"));
			return parts;
		}
		case "file": return [segment.text(p.file.name ? `[文件] ${p.file.name}` : "[文件]")];
		case "audio": return [segment.text(p.text || "[语音]")];
		case "share": return [segment.text(p.share.title ? `[分享] ${p.share.title}` : "[分享]")];
		case "link": return [segment.text(p.link.title ? `[链接] ${p.link.title} ${p.link.url || ""}` : p.text || "[链接]")];
		case "user": return [segment.text(p.user.name ? `[名片] ${p.user.name}` : "[名片]")];
		case "forward": {
			const resId = message.serverMessageId || "";
			if (resId && p.nodes.length) {
				cacheForwardNodes(resId, p.nodes);
				return [segment.longMsg(resId)];
			}
			return [segment.text(p.text || "[合并转发]")];
		}
		default: return [segment.text(p.text || "[未知消息]")];
	}
}
/** 根据 contact 场景把 karin 目标解析为抖音会话地址（friend: 查好友；group: 查群） */
async function resolveAddress(account, contact) {
	if (!contact || !contact.peer) return undefined;
	if (contact.scene === "group") {
		const address = await resolveGroupAddress(account.client, contact.peer);
		if (!address) return undefined;
		return {
			...address,
			groupName: contact.peer
		};
	}
	const address = await resolveFriendAddress(account.client, contact.peer);
	if (!address) return undefined;
	return {
		...address,
		peerUid: contact.peer
	};
}

//#endregion
//#region src/api/profile.ts
/** secUid → 资料（IM user/info 接口结果） */
const profileCache = new Map();
/** uid → secUid 映射（群成员/历史消息/陌生人列表填充） */
const secUidCache = new Map();
/** uid → 昵称/头像（资料查询回填） */
const nickCache = new Map();
const avatarCache = new Map();
/** 批量按 secUid 拉取资料（desktop IM user/info，对齐 douyin-im ImUserDirectory.resolve） */
async function fetchUserProfiles(http, secUids) {
	const result = new Map();
	const missing = [...new Set(secUids.filter(Boolean))].filter((uid) => !profileCache.has(uid));
	for (let offset = 0; offset < missing.length; offset += 50) {
		const batch = missing.slice(offset, offset + 50);
		try {
			const form = new FormData();
			form.append("sec_user_ids", JSON.stringify(batch));
			const params = desktopFingerprintParams(http.deviceId, http.guid);
			params.set("iid", http.installId);
			const res = await http.requestJson(`https://imdesktop.douyin.com/aweme/v1/web/im/user/info/?${params}`, {
				method: "POST",
				body: form,
				headers: { Referer: "https://imdesktop.douyin.com" }
			});
			if (Number(res.data?.status_code ?? -1) !== 0 || !Array.isArray(res.data?.data)) continue;
			for (const raw of res.data.data) {
				const secUid = typeof raw["sec_uid"] === "string" ? raw["sec_uid"] : "";
				if (!secUid || !batch.includes(secUid)) continue;
				const nickname = typeof raw["nickname"] === "string" ? raw["nickname"] : "";
				const thumb = raw["avatar_thumb"];
				const avatar = Array.isArray(thumb?.url_list) ? thumb.url_list.find((u) => typeof u === "string" && u !== "") : undefined;
				if (!nickname && !avatar) continue;
				const profile = {
					...nickname ? { nickname } : {},
					...avatar ? { avatar } : {}
				};
				profileCache.set(secUid, profile);
				result.set(secUid, profile);
			}
		} catch {}
	}
	return result;
}
/** 单个 secUid 资料（批量接口包装） */
async function fetchUserProfile(http, secUid) {
	const cached = profileCache.get(secUid);
	if (cached) return cached;
	const profiles = await fetchUserProfiles(http, [secUid]);
	return profiles.get(secUid) ?? {};
}
function cacheSecUid(uid, secUid) {
	if (uid && uid !== "0" && secUid) secUidCache.set(uid, secUid);
}
function cachedSecUid(uid) {
	return secUidCache.get(uid) ?? "";
}
function cacheUserProfile(uid, profile) {
	if (!uid || uid === "0") return;
	if (profile.nickname) nickCache.set(uid, profile.nickname);
	if (profile.avatar) avatarCache.set(uid, profile.avatar);
}
function cachedNickname(uid) {
	return nickCache.get(uid) ?? "";
}
function cachedAvatar(uid) {
	return avatarCache.get(uid) ?? "";
}

//#endregion
//#region src/adapter/nick.ts
/**
* 联系人资料模型（对齐 douyin-im）：
* - 资料以「会话线程 nickname / cmd=605 participants.secUid → IM user/info 批量」实时获取
* - uid → secUid 为稳定标识映射，昵称/头像随资料查询回填
*/
/** 群 shortId → 群名（群列表填充） */
const groupNameCache = new Map();
/** 正在按需解析的 key（防并发重复拉取） */
const fetching = new Set();
function cachedNick(uid) {
	return cachedNickname(uid);
}
function cachedGroupName(shortId) {
	return groupNameCache.get(shortId) ?? "";
}
function cacheNicks(pairs) {
	for (const [uid, nickname] of pairs) {
		cacheUserProfile(uid, { nickname });
	}
}
/** 按 uid+secUid 对批量拉 IM 资料并回填缓存（对齐 douyin-im resolveUsers） */
async function applyProfiles(http, entries) {
	const list = [...entries].filter((e) => e.uid && e.uid !== "0" && e.secUid);
	if (!list.length) return;
	try {
		const profiles = await fetchUserProfiles(http, list.map((e) => e.secUid));
		for (const entry of list) {
			const profile = profiles.get(entry.secUid);
			if (profile) cacheUserProfile(entry.uid, profile);
		}
	} catch {}
}
/** 预热缓存：好友昵称 + 群名（createBot 后异步执行，不阻塞注册） */
async function warmNickCache(bot) {
	const key = bot.selfId;
	if (fetching.has(key)) return;
	fetching.add(key);
	try {
		try {
			const friends = await getFriendList(bot.ctx.client);
			cacheNicks(friends.map((f) => [f.uid, f.nickname]));
			for (const f of friends) {
				if (f.secUid) cacheSecUid(f.uid, f.secUid);
			}
		} catch {}
		try {
			const groups = await getGroupList(bot.ctx.client);
			for (const g of groups) {
				if (g.conversationShortId && g.name) groupNameCache.set(g.conversationShortId, g.name);
			}
		} catch {}
	} finally {
		fetching.delete(key);
	}
}
/**
* 按需解析昵称（对齐 douyin-im 联系人补全）：
* - 群：cmd=605 participants 携带 secUid → IM user/info 批量拉全群昵称/头像
* - 私聊：会话线程 nickname（好友/陌生人）；指定 secUid 时走 IM 资料接口
*/
async function resolveNick(bot, uid, group, secUid) {
	if (!uid || uid === "0" || cachedNick(uid)) return cachedNick(uid);
	const key = `${bot.selfId}:${uid}:${group?.conversationShortId ?? "dm"}`;
	if (fetching.has(key)) return cachedNick(uid);
	fetching.add(key);
	try {
		if (group) {
			try {
				const members = await getGroupMembers(bot.ctx.client, group);
				for (const m of members) {
					if (m.secUid) cacheSecUid(m.uid, m.secUid);
					if (m.alias) cacheUserProfile(m.uid, { nickname: m.alias });
				}
				await applyProfiles(bot.ctx.http, members);
			} catch {}
		} else {
			try {
				const strangers = await getStrangerList(bot.ctx.client);
				cacheNicks(strangers.map((s) => [s.uid, s.nickname ?? ""]));
				for (const s of strangers) {
					const peerSec = s.lastMessage?.senderSecUid ?? "";
					if (peerSec) cacheSecUid(s.uid, peerSec);
				}
			} catch {}
			const sec = secUid ?? cachedSecUid(uid);
			if (sec && !cachedNick(uid)) {
				try {
					const profiles = await fetchUserProfiles(bot.ctx.http, [sec]);
					const profile = profiles.get(sec);
					if (profile) cacheUserProfile(uid, profile);
				} catch {}
			}
		}
		return cachedNick(uid);
	} finally {
		fetching.delete(key);
	}
}
/** 定位用户 secUid：缓存 → 群 participants / 私聊线程字段 */
async function locateSecUid(bot, uid, group) {
	const known = cachedSecUid(uid);
	if (known) return known;
	if (group) {
		try {
			const members = await getGroupMembers(bot.ctx.client, group);
			for (const m of members) {
				if (m.secUid) cacheSecUid(m.uid, m.secUid);
			}
		} catch {}
	} else {
		try {
			const friends = await getFriendList(bot.ctx.client);
			for (const f of friends) {
				if (f.secUid) cacheSecUid(f.uid, f.secUid);
			}
			if (!cachedSecUid(uid)) {
				const strangers = await getStrangerList(bot.ctx.client);
				for (const s of strangers) {
					const peerSec = s.lastMessage?.senderSecUid ?? "";
					if (peerSec) cacheSecUid(s.uid, peerSec);
				}
			}
		} catch {}
	}
	return cachedSecUid(uid);
}
/** 按需解析群名：拉群列表回填；未命中返回空串 */
async function resolveGroupName(bot, shortId) {
	if (!shortId || groupNameCache.has(shortId)) return cachedGroupName(shortId);
	const key = `${bot.selfId}:g:${shortId}`;
	if (fetching.has(key)) return cachedGroupName(shortId);
	fetching.add(key);
	try {
		try {
			const groups = await getGroupList(bot.ctx.client);
			for (const g of groups) {
				if (g.conversationShortId && g.name) groupNameCache.set(g.conversationShortId, g.name);
			}
		} catch {}
		return cachedGroupName(shortId);
	} finally {
		fetching.delete(key);
	}
}

//#endregion
//#region src/adapter/message.ts
/** 抖音入站消息 → karin 消息事件 */
function dispatchMessage(bot, msg) {
	try {
		if (msg.senderUid === bot.selfId) return;
		if (msg.parsed.kind === "text" && !msg.parsed.text) return;
		const elements = toKarinElements(msg);
		const messageId = msg.serverMessageId || `${msg.cmd}-${msg.indexInConversationV2 ?? msg.indexInConversation ?? Date.now()}`;
		const seq = Number(msg.indexInConversationV2 || msg.indexInConversation || msg.serverMessageId || 0) || Math.floor(Date.now() / 1e3);
		const time = Number(msg.createTime) > 0 ? Math.floor(Number(msg.createTime) / 1e3) : Math.floor(Date.now() / 1e3);
		const nick = cachedNick(msg.senderUid);
		if (msg.conversationType === 2) {
			const peer = msg.conversationShortId || msg.conversationId;
			const groupName = cachedGroupName(peer);
			const contact = contactGroup(peer, groupName || undefined);
			const groupAddress = {
				conversationId: msg.conversationId,
				conversationShortId: msg.conversationShortId,
				conversationType: 2
			};
			if (!nick) void resolveNick(bot, msg.senderUid, groupAddress);
			if (!groupName) void resolveGroupName(bot, peer);
			createGroupMessage({
				bot,
				contact,
				elements,
				eventId: messageId,
				messageId,
				messageSeq: seq,
				rawEvent: msg.raw,
				sender: senderGroup(msg.senderUid, "member", nick || undefined),
				time,
				srcReply: (elems) => bot.sendMsg(contact, elems)
			});
		} else {
			const peer = parsePeerFromConversationId(msg.conversationId, bot.selfId) || msg.senderUid;
			const contact = contactFriend(peer, nick || undefined);
			if (!nick) void resolveNick(bot, msg.senderUid, undefined, msg.senderSecUid);
			createFriendMessage({
				bot,
				contact,
				elements,
				eventId: messageId,
				messageId,
				messageSeq: seq,
				rawEvent: msg.raw,
				sender: senderFriend(msg.senderUid, nick || undefined),
				time,
				srcReply: (elems) => bot.sendMsg(contact, elems)
			});
		}
	} catch (err) {
		logger.error("[douyin] 处理入站消息失败:", err);
	}
}

//#endregion
//#region src/adapter/notice.ts
const now = () => Math.floor(Date.now() / 1e3);
/** 抖音表态键值 → karin faceId（resources/reactions.json 反查，未收录返回 0） */
function emojiToFaceId(emoji) {
	for (const base of [dir.defResourcesDir, path.join(dir.pluginDir, "resources")]) {
		const file = path.join(base, "reactions.json");
		if (fs.existsSync(file)) {
			const table = requireFileSync(file);
			const hit = Object.entries(table).find(([, key]) => key === emoji);
			if (hit) return Number(hit[0]);
		}
	}
	return 0;
}
/** 通知事件公共参数（eventId/rawEvent/time/srcReply 由调用方补 contact/sender/content） */
const common = (bot, raw) => ({
	bot,
	eventId: `douyin-notice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
	rawEvent: raw,
	time: now()
});
/** 抖音通知事件 → karin 通知事件 */
function dispatchNotice(bot, ev) {
	try {
		switch (ev.type) {
			case "message.reaction": {
				const faceId = emojiToFaceId(ev.emoji);
				logger.info(`[抖音] 表情回应: msgId=${ev.serverMessageId} emoji=${ev.emoji} ` + `operator=${ev.operatorUid} isSet=${ev.isSet}`);
				if (!ev.conversationId.startsWith("0:2:")) return;
				const contact = contactGroup(ev.conversationId);
				createGroupMessageReactionNotice({
					...common(bot, ev.raw),
					contact,
					sender: senderGroup(ev.operatorUid, "member"),
					srcReply: (elems) => bot.sendMsg(contact, elems),
					content: {
						messageId: ev.serverMessageId,
						faceId,
						count: 1,
						isSet: ev.isSet
					}
				});
				return;
			}
			case "friend.increase":
			case "friend.decrease": {
				const contact = contactFriend(ev.peerUid);
				const base = {
					...common(bot, ev.raw),
					contact,
					sender: senderFriend(ev.peerUid),
					srcReply: (elems) => bot.sendMsg(contact, elems)
				};
				if (ev.type === "friend.increase") {
					createFriendIncreaseNotice({
						...base,
						content: { targetId: ev.peerUid }
					});
				} else {
					createFriendDecreaseNotice({
						...base,
						content: { targetId: ev.peerUid }
					});
				}
				break;
			}
			case "message.recall": {
				const messageId = ev.serverMessageId ?? "";
				if (ev.conversationType === 2) {
					const operatorId = typeof ev.raw["operatorId"] === "string" ? ev.raw["operatorId"] : "";
					const contact = contactGroup(ev.conversationId);
					createGroupRecallNotice({
						...common(bot, ev.raw),
						contact,
						sender: senderGroup(operatorId, "member"),
						srcReply: (elems) => bot.sendMsg(contact, elems),
						content: {
							operatorId,
							targetId: operatorId,
							messageId,
							tip: ""
						}
					});
				} else {
					const peer = parsePeerFromConversationId(ev.conversationId, bot.selfId) || ev.conversationId;
					const contact = contactFriend(peer);
					createPrivateRecallNotice({
						...common(bot, ev.raw),
						contact,
						sender: senderFriend(peer),
						srcReply: (elems) => bot.sendMsg(contact, elems),
						content: {
							operatorId: peer,
							messageId,
							tips: ""
						}
					});
				}
				break;
			}
			case "group.member-increase": {
				const contact = contactGroup(ev.conversationShortId || ev.conversationId);
				const base = {
					...common(bot, ev.raw),
					contact,
					srcReply: (elems) => bot.sendMsg(contact, elems)
				};
				for (const member of ev.members) {
					createGroupMemberAddNotice({
						...base,
						sender: senderGroup(member.uid, "member"),
						content: {
							operatorId: ev.operators[0]?.uid ?? "",
							targetId: member.uid,
							type: ev.source === "invite" ? "invite" : "approve"
						}
					});
				}
				break;
			}
			case "group.member-decrease": {
				const contact = contactGroup(ev.conversationShortId || ev.conversationId);
				const base = {
					...common(bot, ev.raw),
					contact,
					srcReply: (elems) => bot.sendMsg(contact, elems)
				};
				for (const member of ev.members) {
					createGroupMemberDelNotice({
						...base,
						sender: senderGroup(member.uid, "member"),
						content: {
							operatorId: ev.operators[0]?.uid ?? "",
							targetId: member.uid,
							type: ev.source === "kick" ? "kick" : "leave"
						}
					});
				}
				break;
			}
			case "group.admin": {
				const contact = contactGroup(ev.conversationShortId || ev.conversationId);
				const base = {
					...common(bot, ev.raw),
					contact,
					srcReply: (elems) => bot.sendMsg(contact, elems)
				};
				for (const member of ev.members) {
					createGroupAdminChangedNotice({
						...base,
						sender: senderGroup(member.uid, "member"),
						content: {
							targetId: member.uid,
							isAdmin: true
						}
					});
				}
				break;
			}
			default: logger.debug("[douyin] 未处理通知:", ev.type);
		}
	} catch (err) {
		logger.error("[douyin] 处理通知事件失败:", err);
	}
}

//#endregion
//#region src/adapter/request.ts
/** 抖音请求事件 → karin 请求事件 */
async function dispatchRequest(bot, ev) {
	try {
		if (ev.type === "friend.request") {
			const contact = contactFriend(ev.applicantUid);
			createPrivateApplyRequest({
				bot,
				subEvent: "friendApply",
				contact,
				sender: senderFriend(ev.applicantUid),
				eventId: `douyin-friend-request-${ev.applicantUid}-${Date.now()}`,
				rawEvent: ev.raw,
				time: Math.floor(Date.now() / 1e3),
				srcReply: (elems) => bot.sendMsg(contact, elems),
				content: {
					applierId: ev.applicantUid,
					message: ev.content ?? "",
					flag: ev.applicantUid
				}
			});
			return;
		}
		const list = await bot.ctx.client.getGroupJoinRequests({ conversationShortId: ev.conversationShortId });
		const pending = ev.requestId ? list.find((r) => r.requestId === ev.requestId) : list.find((r) => r.status === 1);
		if (!pending) {
			logger.debug("[douyin] 入群申请审核列表未命中，忽略");
			return;
		}
		const contact = contactGroup(ev.conversationShortId || ev.conversationId);
		createGroupApplyRequest({
			bot,
			subEvent: "groupApply",
			contact,
			sender: senderGroup(pending.applicantUid, "member"),
			eventId: `douyin-group-request-${pending.requestId}-${Date.now()}`,
			rawEvent: ev.raw,
			time: Math.floor(Date.now() / 1e3),
			srcReply: (elems) => bot.sendMsg(contact, elems),
			content: {
				applierId: pending.applicantUid,
				inviterId: pending.inviterUid ?? "",
				reason: pending.reason ?? ev.content ?? "",
				flag: pending.requestId,
				groupId: ev.conversationShortId || ev.conversationId
			}
		});
	} catch (err) {
		logger.error("[douyin] 处理请求事件失败:", err);
	}
}

//#endregion
//#region src/utils/http.ts
const DEFAULT_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";
/**
* @description 下载资源为 Buffer（图片/视频等）
* @param url 资源地址
* @param timeoutMs 超时毫秒，默认 30s
*/
const getBuffer = async (url, timeoutMs = 3e4) => {
	try {
		const res = await axios.get(url, {
			responseType: "arraybuffer",
			timeout: timeoutMs,
			headers: { "User-Agent": DEFAULT_UA }
		});
		return Buffer.from(res.data);
	} catch (error) {
		logger.error(`[douyin] 资源下载失败: ${url}`, error);
		throw error;
	}
};
/**
* @description 请求 JSON 接口
*/
const getJson = async (url, timeoutMs = 3e4) => {
	const res = await axios.get(url, {
		timeout: timeoutMs,
		headers: { "User-Agent": DEFAULT_UA }
	});
	return res.data;
};

//#endregion
//#region src/adapter/util.ts
/** karin 元素 file 字段（url/路径/base64/data URL）→ 原始字节 */
async function fileToBytes(file) {
	if (file.startsWith("base64://")) return Uint8Array.from(Buffer.from(file.slice(9), "base64"));
	const dataUrl = /^data:[^;,]+;base64,(.+)$/is.exec(file);
	if (dataUrl) return Uint8Array.from(Buffer.from(dataUrl[1], "base64"));
	if (/^https?:\/\//i.test(file)) return await getBuffer(file);
	if (file.length > 100 && /^[A-Za-z0-9+/=\r\n]+$/.test(file)) {
		return Uint8Array.from(Buffer.from(file, "base64"));
	}
	const path = file.startsWith("file://") ? fileURLToPath(file) : file;
	return Uint8Array.from(fs.readFileSync(path));
}
const FILE_MAGIC = [
	["png", Uint8Array.from([
		137,
		80,
		78,
		71
	])],
	["jpg", Uint8Array.from([
		255,
		216,
		255
	])],
	["gif", Uint8Array.from([
		71,
		73,
		70,
		56
	])],
	["pdf", Uint8Array.from([
		37,
		80,
		68,
		70
	])],
	["zip", Uint8Array.from([
		80,
		75,
		3,
		4
	])]
];
/** 魔数嗅探文件扩展名（发送侧 name 缺失时补全 format/审核需要） */
function sniffFileExt(data) {
	for (const [ext, magic] of FILE_MAGIC) {
		if (magic.every((byte, index) => data[index] === byte)) return ext;
	}
	if (data.length >= 12 && data[4] === 102 && data[5] === 116 && data[6] === 121 && data[7] === 112) return "mp4";
	if (data[0] === 73 && data[1] === 68 && data[2] === 51) return "mp3";
	return "";
}

//#endregion
//#region src/adapter/send.ts
/** 1x1 JPEG 占位封面（视频发送必需 poster） */
const POSTER_JPEG = Uint8Array.from(Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==", "base64"));
/** nodeDirect 节点补全：查最近历史定位原消息（uid/摘要/类型） */
async function resolveDirectNodes(account, address, messageIds) {
	const wanted = new Set(messageIds);
	const nodes = new Map();
	try {
		const history = await getHistory(account.client, address, { count: 60 });
		for (const msg of history) {
			if (!msg.msgId || !wanted.has(msg.msgId)) continue;
			nodes.set(msg.msgId, {
				uid: msg.senderUid,
				nickname: cachedNick(msg.senderUid) || msg.senderUid,
				text: displayText(msg.content, msg.msgType),
				msgType: msg.msgType,
				aweType: 0,
				msgId: msg.msgId,
				...msg.senderSecUid ? { secUid: msg.senderSecUid } : {},
				...msg.createTime ? { createTime: msg.createTime } : {}
			});
		}
	} catch {}
	return messageIds.map((id) => nodes.get(id) ?? {
		uid: "0",
		nickname: "",
		text: "[消息]",
		msgType: 7,
		aweType: 700,
		msgId: id
	});
}
/** 引用回复补全：查最近历史定位被引用消息（发送者/类型/摘要） */
async function resolveReplyOptions(account, address, referencedMessageId, text) {
	try {
		const history = await getHistory(account.client, address, { count: 60 });
		const ref = history.find((m) => m.msgId === referencedMessageId);
		if (!ref) return undefined;
		return {
			...address,
			text,
			referencedMessageId,
			referencedMessageType: ref.msgType,
			referencedUid: ref.senderUid,
			...ref.senderSecUid ? { referencedSecUid: ref.senderSecUid } : {},
			nickname: cachedNick(ref.senderUid) || "",
			referencedText: displayText(ref.content, ref.msgType)
		};
	} catch {
		return undefined;
	}
}
/** 收集合并转发节点：fake（自定义）+ messageID（引用真实消息） */
async function collectForwardNodes(account, address, elements) {
	const fakes = [];
	const directs = [];
	for (const el of elements) {
		if (el.type !== "node") continue;
		if (el.subType === "fake") {
			fakes.push({
				userId: el.userId,
				nickname: el.nickname,
				message: el.message.map((inner) => {
					const obj = inner;
					return {
						type: String(obj.type ?? "text"),
						text: obj.text
					};
				})
			});
		} else if (el.subType === "messageID") {
			directs.push(el.messageId || el.message_id);
		}
	}
	if (!fakes.length && !directs.length) return undefined;
	const directNodes = directs.length ? await resolveDirectNodes(account, address, directs.filter(Boolean)) : [];
	return [...buildForwardNodes(fakes, account.platformUid, undefined), ...directNodes];
}
/** karin 元素 → 抖音消息（文本聚合发送；图片/视频逐个上传发送） */
async function sendKarinElements(account, contact, elements) {
	const address = await resolveAddress(account, contact);
	if (!address) throw new Error(`[douyin] 无法解析会话目标: ${contact.scene} ${contact.peer}`);
	const forwardNodes = await collectForwardNodes(account, address, elements);
	if (forwardNodes) {
		const result = await sendForwardNodes(account.client, address, forwardNodes, account.platformUid);
		if (result.statusCode !== 0) logger.warn(`[douyin] 合并转发被拒: ${result.statusMsg}`);
		const messageId = result.serverMessageId ?? "";
		const time = Date.now();
		return {
			messageId,
			time,
			rawData: result,
			message_id: messageId,
			messageTime: time
		};
	}
	let last;
	let text = "";
	let pendingReplyId = "";
	const mentions = [];
	const flush = async () => {
		const chunk = text.trim();
		text = "";
		if (!chunk) return;
		if (pendingReplyId) {
			const options = await resolveReplyOptions(account, address, pendingReplyId, chunk);
			pendingReplyId = "";
			last = options ? await reply(account.client, options) : await sendText(account.client, address, chunk);
			return;
		}
		const valid = mentions.filter((m) => /^\d+$/.test(m.uid));
		mentions.length = 0;
		last = await sendText(account.client, address, chunk, valid.length ? valid : undefined);
	};
	for (const el of elements) {
		try {
			switch (el.type) {
				case "text":
					text += el.text;
					break;
				case "at": {
					const label = `@${el.name || el.targetId}`;
					mentions.push({
						uid: el.targetId,
						text: label,
						location: text.length,
						length: label.length
					});
					text += label;
					break;
				}
				case "face":
					text += `[表情:${el.id}]`;
					break;
				case "reply":
					pendingReplyId = el.messageId;
					break;
				case "image":
					await flush();
					last = await sendImage(account.client, address, await fileToBytes(el.file));
					break;
				case "video":
					await flush();
					last = await sendVideo(account.client, address, await fileToBytes(el.file), POSTER_JPEG, el.width || 720, el.height || 1280);
					break;
				case "record":
					text += "[语音]暂不支持";
					break;
				case "file": {
					await flush();
					const bytes = await fileToBytes(el.file);
					const name = /\.[a-z0-9]+$/i.test(el.name || "") ? el.name : `${el.name || "file"}${sniffFileExt(bytes) ? `.${sniffFileExt(bytes)}` : ""}`;
					last = await sendFile(account.client, address, bytes, name);
					break;
				}
				case "reply": break;
				default: break;
			}
		} catch (err) {
			logger.error(`[douyin] 发送元素 ${el.type} 失败:`, err);
		}
	}
	await flush();
	const messageId = last?.serverMessageId ?? "";
	const time = Date.now();
	return {
		messageId,
		time,
		rawData: last ?? [],
		message_id: messageId,
		messageTime: time
	};
}

//#endregion
//#region src/adapter/login.ts
/** 扫码登录并注册适配器（供指令层调用） */
async function loginByQr(options = {}) {
	const manager = getAccountManager();
	const ctx = await manager.loginByQr(options);
	await createBot(ctx);
	logger.info(`[douyin] 扫码登录成功: ${ctx.platformUid}`);
	return ctx;
}

//#endregion
//#region src/adapter/index.ts
/** 账号管理器单例 */
let manager;
function getAccountManager() {
	manager ??= createAccountManager();
	return manager;
}
/** 抖音 CDN 头像尺寸替换：`~c5_168x168.webp` → `~c5_{size}x{size}`；size=0 或无尺寸段原样返回 */
function avatarBySize(url, size) {
	if (!url || !size) return url;
	return url.replace(/(~c5_)\d+x\d+/, `$1${size}x${size}`);
}
/** 数字 faceId → 抖音表态键（resources/reactions.json，1-6 为官方回应面板） */
const REACTION_KEYS = loadReactionKeys();
function loadReactionKeys() {
	for (const base of [dir.defResourcesDir, path.join(dir.pluginDir, "resources")]) {
		const file = path.join(base, "reactions.json");
		if (fs.existsSync(file)) return requireFileSync(file);
	}
	return {};
}
/** 从 ChatMessage.content（JSON 字符串）提取纯文本摘要 */
function chatContentText(msg) {
	try {
		const parsed = JSON.parse(msg.content);
		if (typeof parsed.text === "string" && parsed.text) return parsed.text;
	} catch {}
	return msg.content;
}
/** ChatMessage → karin MessageResponse（昵称取同步缓存，未命中由事件链路异步补） */
function toMessageResponse(contact, msg) {
	return {
		time: msg.createTime,
		messageId: msg.msgId,
		messageSeq: Number(msg.indexInConversation ?? 0),
		contact,
		sender: {
			userId: msg.senderUid,
			nick: cachedNick(msg.senderUid),
			role: "member"
		},
		elements: [segment.text(chatContentText(msg))]
	};
}
/** 抖音群成员 role 数字 → karin Role */
function toKarinRole(role) {
	if (role === 1) return "owner";
	if (role === 2) return "admin";
	return "member";
}
/** 抖音适配器（单账号实例） */
var AdapterDouyin = class extends AdapterBase {
	ctx;
	constructor(ctx) {
		super();
		this.ctx = ctx;
		this.adapter.name = "douyin";
		this.adapter.version = dir.pkg.version;
		this.adapter.platform = "douyin";
		this.adapter.standard = "other";
		this.adapter.protocol = "douyin";
		this.adapter.communication = "webSocketClient";
		this.adapter.address = "wss://frontier-msns.douyin.com/ws/v2";
		this.account.selfId = ctx.platformUid;
		this.account.name = ctx.config.name ?? "";
		this.account.avatar = String(getAccountManager().store.load(ctx.platformUid)?.userData?.avatar_url ?? "");
	}
	/** 发送消息（karin 调用） */
	async sendMsg(contact, elements) {
		return sendKarinElements(this.ctx, contact, elements);
	}
	/** 撤回消息 */
	async recallMsg(contact, messageId) {
		const address = await resolveAddress(this.ctx, contact);
		if (!address) throw new Error(`[douyin] 无法解析会话目标: ${contact.scene} ${contact.peer}`);
		const result = await recall(this.ctx.client, address, messageId);
		if (!result.recalled) logger.warn(`[douyin] 撤回失败: ${result.statusMsg}`);
	}
	/** 消息表情回应：faceId 1-6 为回应面板（爱心/大笑/惊讶/泪奔/赞/抱拳），文本表情键原样透传 */
	async setMsgReaction(contact, messageId, faceId, isSet) {
		const address = await resolveAddress(this.ctx, contact);
		if (!address) throw new Error(`[douyin] 无法解析会话目标: ${contact.scene} ${contact.peer}`);
		const key = String(faceId);
		const emoji = /^\d+$/.test(key) ? REACTION_KEYS[key] : key;
		if (!emoji) throw new Error(`[douyin] 未知的表情回应 faceId: ${faceId}`);
		const result = await this.ctx.client.modifyReaction({
			...address,
			serverMessageId: messageId,
			emoji,
			operatorUid: this.ctx.platformUid,
			enabled: isSet
		});
		if (result.statusCode !== 0) logger.warn(`[douyin] 表情回应失败: statusCode=${result.statusCode} ${result.statusMsg}`);
	}
	/** 好友列表（昵称：线程 alias → IM user/info 批量回填） */
	async getFriendList() {
		const list = await getFriendList(this.ctx.client);
		await applyProfiles(this.ctx.http, list);
		return list.map((f) => ({
			userId: f.uid,
			nick: f.nickname || cachedNick(f.uid)
		}));
	}
	/** 用户昵称：缓存命中直接返回；未命中走解析链（好友/群成员/陌生人 → IM 资料接口） */
	async getNickname(userId) {
		if (userId === this.account.selfId) {
			const record = getAccountManager().store.load(this.account.selfId);
			return String(record?.screenName ?? record?.userData?.screen_name ?? "");
		}
		return resolveNick(this, userId);
	}
	/** 用户头像：自身取登录资料；他人按 secUid 查 IM user/info。size 对齐官方 0|100|40|140 */
	async getAvatarUrl(userId, size) {
		const uid = userId || this.account.selfId;
		const raw = uid === this.account.selfId ? await this.selfAvatarUrl() : await this.peerAvatarUrl(uid);
		return avatarBySize(raw, size ?? 0);
	}
	/** 自身头像：登录资料（mosaic 占位实时刷新） */
	async selfAvatarUrl() {
		const store = getAccountManager().store;
		const record = store.load(this.account.selfId);
		const cached = String(record?.userData?.avatar_url ?? "");
		if (cached && !cached.includes("mosaic")) return cached;
		const profile = await fetchDesktopSelfProfile(this.ctx.http).catch(() => undefined);
		const avatar = profile?.avatar ?? "";
		if (avatar && record) {
			store.save(this.account.selfId, {
				...record,
				userData: {
					...record.userData,
					avatar_url: avatar
				},
				updatedAt: new Date().toISOString()
			});
		}
		return avatar || cached;
	}
	/** 他人头像：定位 secUid 后批量资料接口取 avatar_thumb */
	async peerAvatarUrl(uid) {
		const cachedAvatar$1 = cachedAvatar(uid);
		if (cachedAvatar$1) return cachedAvatar$1;
		const secUid = await locateSecUid(this, uid);
		if (!secUid) return "";
		const profiles = await fetchUserProfiles(this.ctx.http, [secUid]).catch(() => undefined);
		const avatar = profiles?.get(secUid)?.avatar ?? "";
		if (avatar) cacheUserProfile(uid, { avatar });
		return avatar;
	}
	/** 群列表 */
	async getGroupList() {
		const list = await getGroupList(this.ctx.client);
		return list.map((g) => ({
			groupId: g.conversationShortId || g.conversationId,
			groupName: g.name,
			memberCount: g.members.length,
			avatar: g.avatar ?? ""
		}));
	}
	/** 群信息（从群列表匹配） */
	async getGroupInfo(groupId) {
		const groups = await getGroupList(this.ctx.client);
		const group = groups.find((g) => g.conversationId === groupId || g.conversationShortId === groupId || g.name === groupId);
		if (!group) throw new Error(`[douyin] 未找到群: ${groupId}`);
		return {
			groupId: group.conversationShortId || group.conversationId,
			groupName: group.name,
			memberCount: group.members.length,
			avatar: group.avatar ?? ""
		};
	}
	/** 群头像 */
	async getGroupAvatarUrl(groupId) {
		const groups = await getGroupList(this.ctx.client);
		const group = groups.find((g) => g.conversationId === groupId || g.conversationShortId === groupId || g.name === groupId);
		return group?.avatar ?? "";
	}
	/** 群成员列表（昵称：alias 常空，IM user/info 批量回填） */
	async getGroupMemberList(groupId) {
		const address = await resolveGroupAddress(this.ctx.client, groupId);
		if (!address) throw new Error(`[douyin] 未找到群: ${groupId}`);
		const members = await getGroupMembers(this.ctx.client, address);
		await applyProfiles(this.ctx.http, members);
		return members.map((m) => ({
			userId: m.uid,
			nick: cachedNick(m.uid) || m.alias || m.uid,
			card: m.alias ?? "",
			role: toKarinRole(m.role),
			avatar: m.avatar ?? ""
		}));
	}
	/** 群成员信息 */
	async getGroupMemberInfo(groupId, targetId) {
		const list = await this.getGroupMemberList(groupId);
		const member = list.find((m) => m.userId === targetId);
		if (!member) throw new Error(`[douyin] 群 ${groupId} 未找到成员: ${targetId}`);
		return member;
	}
	/** 陌生人信息 */
	async getStrangerInfo(targetId) {
		const list = await getStrangerList(this.ctx.client);
		const stranger = list.find((s) => s.uid === targetId);
		if (!stranger) throw new Error(`[douyin] 未找到陌生人会话: ${targetId}`);
		return {
			userId: stranger.uid,
			nick: stranger.nickname ?? ""
		};
	}
	async getMsg(a, b) {
		if (typeof a === "string") {
			throw new Error("[douyin] getMsg(messageId) 不支持，请提供会话 contact");
		}
		const address = await this.requireAddress(a);
		const history = await getHistory(this.ctx.client, address);
		const msg = b ? history.find((m) => m.msgId === b) : history[history.length - 1];
		if (!msg) throw new Error(`[douyin] 未找到消息: ${b || "(最近)"}`);
		return toMessageResponse(a, msg);
	}
	/** 获取历史消息：start 为 indexInConversation 游标（或消息 ID），返回 ≤start 的 count 条（时间正序） */
	async getHistoryMsg(contact, start, count) {
		const address = await this.requireAddress(contact);
		const limit = count || 1;
		const anchor = typeof start === "object" && start !== null ? start.seq : start;
		let cursor = Number(anchor);
		if (!Number.isFinite(cursor) || cursor <= 0) {
			cursor = 0;
			if (anchor) {
				const recent = await getHistory(this.ctx.client, address);
				const hit = recent.find((m) => m.msgId === String(anchor));
				cursor = Number(hit?.indexInConversation ?? 0);
			}
		}
		const history = await getHistory(this.ctx.client, address, {
			cursor,
			count: limit
		});
		const sorted = [...history].sort((a, b) => (Number(a.indexInConversation) || 0) - (Number(b.indexInConversation) || 0));
		return sorted.slice(-limit).map((m) => toMessageResponse(contact, m));
	}
	/** 获取账号 Cookie */
	async getCookies() {
		return { cookie: this.ctx.http.getCookies() };
	}
	/** 获取 QQ 相关接口凭证（抖音返回 cookie 与 passport csrf token） */
	async getCredentials() {
		const csrf = Number(this.ctx.http.jar.get("passport_csrf_token") ?? 0);
		return {
			cookies: this.ctx.http.getCookies(),
			csrf_token: Number.isFinite(csrf) ? csrf : 0
		};
	}
	/** 获取 CSRF Token */
	async getCSRFToken() {
		const csrf = Number(this.ctx.http.jar.get("passport_csrf_token") ?? 0);
		return { token: Number.isFinite(csrf) ? csrf : 0 };
	}
	/** 解析 karin contact → 抖音会话地址 */
	async requireAddress(contact) {
		const address = await resolveAddress(this.ctx, contact);
		if (!address) throw new Error(`[douyin] 无法解析会话目标: ${contact.scene} ${contact.peer}`);
		return address;
	}
	/** 处理好友申请（flag = 申请者 uid） */
	async setFriendApplyResult(flag, isApprove) {
		if (isApprove) await approveFriend(this.ctx.client, flag);
		else await rejectFriend(this.ctx.client, flag);
	}
	/** 处理入群申请（flag = requestId） */
	async setGroupApplyResult(flag, isApprove) {
		if (isApprove) await approveGroupJoin(this.ctx.client, flag);
		else await rejectGroupJoin(this.ctx.client, flag);
	}
	/** 设置群名（cmd=902 set_conversation_core_info） */
	async setGroupName(groupId, groupName) {
		const address = await resolveGroupAddress(this.ctx.client, groupId);
		if (!address) throw new Error(`[douyin] 未找到群: ${groupId}`);
		const result = await setGroupName(this.ctx.client, address, groupName);
		if (result.statusCode !== 0) {
			throw new Error(`[douyin] 设置群名失败: ${result.statusMsg} (code=${result.statusCode})`);
		}
	}
	/** 邀请入群审批（抖音无独立接口） */ setInvitedJoinGroupResult() {
		return this.unsupported("setInvitedJoinGroupResult");
	}
	/** 打印不支持日志并抛错 */
	unsupported(method) {
		logger.error(`[douyin] 不支持的操作: ${method}（抖音平台无此能力）`);
		throw new Error(`[douyin] 抖音平台不支持: ${method}`);
	}
	/** 点赞 */ sendLike() {
		return this.unsupported("sendLike");
	}
	/** 戳一戳 */ pokeUser() {
		return this.unsupported("pokeUser");
	}
	/** 消息表情回应（别名） */ setMessageReaction() {
		return this.unsupported("setMessageReaction");
	}
	/** 合并转发资源（发送侧直接用 node 节点，无需预上传） */ createResId() {
		return this.unsupported("createResId");
	}
	/** 获取合并转发（resId = 合并转发消息 ID，取入站时缓存的节点） */
	async getForwardMsg(resId) {
		const nodes = loadForwardNodes(resId);
		if (!nodes?.length) throw new Error(`[douyin] 未找到合并转发: ${resId}`);
		return nodes.map((node, index) => ({
			time: node.createTime ? Math.floor(node.createTime / 1e3) : Math.floor(Date.now() / 1e3),
			messageId: node.msgId,
			messageSeq: index + 1,
			contact: contactFriend(node.uid, node.nickname || undefined),
			sender: {
				userId: node.uid,
				nick: node.nickname,
				role: "member"
			},
			elements: [segment.text(node.text)]
		}));
	}
	/** 发送合并转发 */ sendForwardMsg() {
		return this.unsupported("sendForwardMsg");
	}
	/** 长消息 */ sendLongMsg() {
		return this.unsupported("sendLongMsg");
	}
	/** 踢人 */ groupKickMember() {
		return this.unsupported("groupKickMember");
	}
	/** 退群 */ setGroupQuit() {
		return this.unsupported("setGroupQuit");
	}
	/** 单人禁言 */ setGroupMute() {
		return this.unsupported("setGroupMute");
	}
	/** 单人禁言（别名） */ setGroupBan() {
		return this.unsupported("setGroupBan");
	}
	/** 全员禁言 */ setGroupAllMute() {
		return this.unsupported("setGroupAllMute");
	}
	/** 全员禁言（别名） */ setGroupWholeBan() {
		return this.unsupported("setGroupWholeBan");
	}
	/** 群名片 */ setGroupCard() {
		return this.unsupported("setGroupCard");
	}
	/** 群名片（别名） */ setGroupMemberCard() {
		return this.unsupported("setGroupMemberCard");
	}
	/** 群管理员 */ setGroupAdmin() {
		return this.unsupported("setGroupAdmin");
	}
	/** 成员头衔 */ setGroupMemberTitle() {
		return this.unsupported("setGroupMemberTitle");
	}
	/** 专属头衔 */ setGroupSpecialTitle() {
		return this.unsupported("setGroupSpecialTitle");
	}
	/** 群公告 */ setGroupNotice() {
		return this.unsupported("setGroupNotice");
	}
	/** 群公告（别名） */ sendGroupNotice() {
		return this.unsupported("sendGroupNotice");
	}
	/** 删除群公告 */ delGroupNotice() {
		return this.unsupported("delGroupNotice");
	}
	/** 加精华 */ setEssenceMsg() {
		return this.unsupported("setEssenceMsg");
	}
	/** 加精华（别名） */ setGroupHighlights() {
		return this.unsupported("setGroupHighlights");
	}
	/** 移除精华 */ deleteEssenceMsg() {
		return this.unsupported("deleteEssenceMsg");
	}
	/** 精华列表 */ getGroupHighlights() {
		return this.unsupported("getGroupHighlights");
	}
	/** 群头衔/群头像 */ setGroupPortrait() {
		return this.unsupported("setGroupPortrait");
	}
	/** 群备注 */ setGroupRemark() {
		return this.unsupported("setGroupRemark");
	}
	/** 群荣誉 */ getGroupHonor() {
		return this.unsupported("getGroupHonor");
	}
	/** 群荣誉（别名） */ getGroupHonorInfo() {
		return this.unsupported("getGroupHonorInfo");
	}
	/** 陌生群信息 */ getNotJoinedGroupInfo() {
		return this.unsupported("getNotJoinedGroupInfo");
	}
	/** 群禁言列表 */ getGroupMuteList() {
		return this.unsupported("getGroupMuteList");
	}
	/** @全体剩余次数 */ getGroupAtAllRemain() {
		return this.unsupported("getGroupAtAllRemain");
	}
	/** @全体次数（抖音桌面 IM 无 @全体能力） */ getAtAllCount(_groupId) {
		return this.unsupported("getAtAllCount");
	}
	/** 上传文件 */ uploadFile() {
		return this.unsupported("uploadFile");
	}
	/** 上传群文件 */ uploadGroupFile() {
		return this.unsupported("uploadGroupFile");
	}
	/** 上传私聊文件 */ uploadPrivateFile() {
		return this.unsupported("uploadPrivateFile");
	}
	/** 下载文件 */ downloadFile() {
		return this.unsupported("downloadFile");
	}
	/** 文件链接 */ getFileUrl() {
		return this.unsupported("getFileUrl");
	}
	/** 私聊文件链接 */ getPrivateFileUrl() {
		return this.unsupported("getPrivateFileUrl");
	}
	/** rkey */ getRkey() {
		return this.unsupported("getRkey");
	}
	/** 群文件列表 */ getGroupFileList() {
		return this.unsupported("getGroupFileList");
	}
	/** 群文件系统信息 */ getGroupFileSystemInfo() {
		return this.unsupported("getGroupFileSystemInfo");
	}
	/** 群文件链接 */ getGroupFileUrl() {
		return this.unsupported("getGroupFileUrl");
	}
	/** 根目录文件 */ getGroupRootFiles() {
		return this.unsupported("getGroupRootFiles");
	}
	/** 文件夹内文件 */ getGroupFilesByFolder() {
		return this.unsupported("getGroupFilesByFolder");
	}
	/** 建群文件夹 */ createGroupFileFolder() {
		return this.unsupported("createGroupFileFolder");
	}
	/** 建群文件夹（别名） */ createGroupFolder() {
		return this.unsupported("createGroupFolder");
	}
	/** 删群文件 */ deleteGroupFile() {
		return this.unsupported("deleteGroupFile");
	}
	/** 删群文件（别名） */ delGroupFile() {
		return this.unsupported("delGroupFile");
	}
	/** 删群文件夹 */ deleteGroupFolder() {
		return this.unsupported("deleteGroupFolder");
	}
	/** 删群文件夹（别名） */ delGroupFolder() {
		return this.unsupported("delGroupFolder");
	}
	/** 重命名群文件夹 */ renameGroupFolder() {
		return this.unsupported("renameGroupFolder");
	}
	/** 移动群文件 */ moveGroupFile() {
		return this.unsupported("moveGroupFile");
	}
	/** 修改头像 */ setAvatar() {
		return this.unsupported("setAvatar");
	}
	/** 修改头像（QQ 别名） */ setQqAvatar() {
		return this.unsupported("setQqAvatar");
	}
	/** 删除好友 */ deleteFriend() {
		return this.unsupported("deleteFriend");
	}
	/** 删除单向好友 */ deleteUnidirectionalFriend() {
		return this.unsupported("deleteUnidirectionalFriend");
	}
	/** 单向好友列表 */ getUnidirectionalFriendList() {
		return this.unsupported("getUnidirectionalFriendList");
	}
	/** 群签到 */ sendGroupSign() {
		return this.unsupported("sendGroupSign");
	}
	/** 群 AI 语音 */ sendGroupAiRecord() {
		return this.unsupported("sendGroupAiRecord");
	}
	/** AI 角色语音 */ sendAiCharacter() {
		return this.unsupported("sendAiCharacter");
	}
	/** AI 角色列表 */ getAiCharacters() {
		return this.unsupported("getAiCharacters");
	}
	/** OCR 图片 */ ocrImage() {
		return this.unsupported("ocrImage");
	}
	/** OCR 图片（别名） */ dotOcrImage() {
		return this.unsupported("dotOcrImage");
	}
	/** 获取图片 */ getImage() {
		return this.unsupported("getImage");
	}
	/** 获取语音 */ getRecord() {
		return this.unsupported("getRecord");
	}
	/** 分词 */ getWordSlices() {
		return this.unsupported("getWordSlices");
	}
	/** 自定义表情 */ fetchCustomFace() {
		return this.unsupported("fetchCustomFace");
	}
	/** 群系统消息 */ getGroupSystemMsg() {
		return this.unsupported("getGroupSystemMsg");
	}
	/** 修改头像（别名） */ setBotInfo() {
		return this.unsupported("setBotInfo");
	}
};
/** 已注册 bot 索引：platformUid → 适配器实例 */
const bots = new Map();
/** 注册单个账号为 karin bot：绑定事件、注册、启动 WS 接收 */
async function createBot(ctx) {
	const prev = bots.get(ctx.platformUid);
	if (prev) await destroyBot(prev);
	const bot = new AdapterDouyin(ctx);
	ctx.client.on("message", (msg) => dispatchMessage(bot, msg));
	ctx.client.on("notice", (ev) => dispatchNotice(bot, ev));
	ctx.client.on("request", (ev) => dispatchRequest(bot, ev));
	ctx.client.on("reconnecting", () => logger.debug(`[douyin][${ctx.platformUid}] WS 重连中`));
	ctx.client.on("close", () => logger.warn(`[douyin][${ctx.platformUid}] WS 连接关闭`));
	bots.set(ctx.platformUid, bot);
	bot.adapter.index = registerBot("webSocketClient", bot);
	void warmNickCache(bot);
	await ctx.client.start();
	logger.info(`[douyin] 账号 ${ctx.platformUid}(${ctx.config.name || "未命名"}) 已上线`);
	return bot;
}
/** 卸载 bot：断开连接并从 karin 注销 */
async function destroyBot(bot) {
	bots.delete(bot.ctx.platformUid);
	bot.ctx.client.stop();
	unregisterBot("selfId", bot.account.selfId);
	logger.info(`[douyin] 账号 ${bot.ctx.platformUid} 已卸载`);
}
/** 账号下线：卸载 bot（保留本地会话，重启后自动恢复） */
async function logoutBot(platformUid) {
	const bot = bots.get(platformUid);
	if (bot) await destroyBot(bot);
}
/** 当前在线的抖音 bot 列表 */
function getBots() {
	return [...bots.values()];
}
/** 启动适配器：恢复配置中启用的账号并注册 */
async function initAdapter() {
	const m = getAccountManager();
	await m.restore();
	await Promise.all([...m.accounts.values()].map((ctx) => createBot(ctx)));
}

//#endregion
export { loginByQr as i, initAdapter as n, logoutBot as r, getBots as t };