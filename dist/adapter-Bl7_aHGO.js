import { dir } from "./dir.js";
import { n as onConfigChange, r as upsertAccount, t as config$1 } from "./config-DYAS3Xg8.js";
import path, { join } from "node:path";
import { AdapterBase, app, config, contactFriend, contactGroup, createFriendDecreaseNotice, createFriendIncreaseNotice, createFriendMessage, createGroupAdminChangedNotice, createGroupApplyRequest, createGroupMemberAddNotice, createGroupMemberDelNotice, createGroupMessage, createGroupMessageReactionNotice, createGroupRecallNotice, createPrivateApplyRequest, createPrivateRecallNotice, hooks, logger, registerBot, requireFileSync, segment, senderFriend, senderGroup, unregisterBot } from "node-karin";
import fs, { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { Bot, chatIdOf, decryptCencMp4, login } from "douyin.ts";
import { createDecipheriv } from "node:crypto";
import { Readable } from "node:stream";

//#region src/store/account.ts
/** 账号会话持久化：每个账号一个目录 `<accountsDir>/<platformUid>/session.json` */
var AccountStore = class {
	accountsDir;
	constructor(accountsDir) {
		this.accountsDir = accountsDir;
		mkdirSync(accountsDir, { recursive: true });
	}
	/** 读取单个账号；不存在返回 undefined */
	load(platformUid) {
		const file = join(this.accountsDir, platformUid, "session.json");
		if (!existsSync(file)) return undefined;
		return JSON.parse(readFileSync(file, "utf8"));
	}
	/** 写入/覆盖账号 */
	save(platformUid, data) {
		const dir = join(this.accountsDir, platformUid);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "session.json"), JSON.stringify(data, null, 2));
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
//#region src/utils/im.ts
/** 官方 PC 客户端 UA（桌面 IM HTTP 接口共用） */
const DESKTOP_PC_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) douyin/8.5.302 Chrome/136.0.7103.59 Electron/36.4.0-rs.31.release.pgo.7 TTElectron/36.4.0-rs.31.release.pgo.7 Safari/537.36 awemePcClient/8.5.302 buildId/469548567 osName/Windows";
/** 节点摘要：文字原样，媒体占位 */
function nodeSummaryText(message) {
	return message.map((el) => {
		switch (el.type) {
			case "text": return el.text ?? "";
			case "image": return "[图片]";
			case "video": return "[视频]";
			case "record": return "[语音]";
			default: return `[${el.type}]`;
		}
	}).join("");
}
/** 节点消息类型：图片 27/2702，其余按文本 7/700 */
function nodeMessageType(message) {
	return message[0]?.type === "image" ? {
		msgType: 27,
		aweType: 2702
	} : {
		msgType: 7,
		aweType: 700
	};
}
/** karin fake node → 合并转发节点（客户端生成 19 位数字 msg_id） */
function buildForwardNodes(nodes, selfUid) {
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
			createTime: timestamp
		};
	});
}
/** 从会话 ID（`0:1:{uidA}:{uidB}`）解析对端 UID 与自身不相同时返回对端，否则返回空串 */
function parsePeerFromConversationId(conversationId, myUid) {
	const parts = conversationId.split(":");
	if (parts.length >= 4 && parts[1] === "1") {
		const uidA = parts[2];
		const uidB = parts[3];
		return uidA === myUid ? uidB : uidA;
	}
	return "";
}
/** SDK 日志收敛到 karin：info 降为 debug（协议帧等调试信息默认隐藏），warn/error 对应转发，格式统一 karin 日志 */
const sdkLog = {
	info: (msg) => logger.debug(`[douyin] ${msg}`),
	warn: (msg) => logger.warn(`[douyin] ${msg}`),
	error: (msg) => logger.error(`[douyin] ${msg}`)
};

//#endregion
//#region src/api/account.ts
/** 构建适配器级账号管理器 */
function createAccountManager() {
	const store = new AccountStore(dir.accountsDir);
	const accounts = new Map();
	const build = (platformUid, session, name) => {
		const bot = new Bot({
			cookie: session.cookie,
			log: sdkLog
		});
		return {
			platformUid,
			config: { name },
			bot
		};
	};
	/** 登录会话落盘（扁平结构：cookie 作为唯一凭据） */
	const persist = (session) => {
		const platformUid = session.userId;
		const prev = store.load(platformUid);
		const screenName = String(session.userData?.screen_name ?? "") || prev?.screenName;
		store.save(platformUid, {
			platformUid,
			cookie: session.cookie,
			...session.userData ? { userData: session.userData } : {},
			...screenName ? { screenName } : {},
			createdAt: prev?.createdAt ?? new Date().toISOString(),
			updatedAt: new Date().toISOString()
		});
	};
	/** 账号 name 是否匹配本地会话（restore 停用判定同源逻辑） */
	const matchName = (record, name) => record.screenName === name;
	/** 从本地会话按昵称构建账号并登记（无会话返回 undefined） */
	const enableAccount = (name) => {
		const record = store.list().find((r) => r.cookie?.trim() && matchName(r, name));
		if (!record) {
			logger.warn(`[douyin] 启用账号失败，未找到本地会话: ${name}（请先扫码登录）`);
			return undefined;
		}
		const acc = build(record.platformUid, {
			userId: record.platformUid,
			cookie: record.cookie
		}, record.screenName);
		accounts.set(acc.platformUid, acc);
		return acc;
	};
	/** 下线账号但保留本地会话（重启或重新启用时恢复） */
	const disableAccount = (name) => {
		const acc = [...accounts.values()].find((a) => a.config.name === name);
		if (acc) {
			acc.bot.stop();
			accounts.delete(acc.platformUid);
		}
	};
	const restore = async () => {
		const disabled = new Set(config$1().accounts.filter((a) => a.enable === false).map((a) => a.name ?? ""));
		for (const record of store.list()) {
			if (!record.cookie?.trim()) continue;
			if (disabled.size > 0 && [...disabled].some((d) => matchName(record, d))) continue;
			accounts.set(record.platformUid, build(record.platformUid, {
				userId: record.platformUid,
				cookie: record.cookie
			}, record.screenName));
		}
	};
	const loginAccount = async (options = {}) => {
		const session = await login({
			...options,
			log: sdkLog
		});
		persist(session);
		const platformUid = session.userId;
		const name = store.load(platformUid)?.screenName;
		const acc = build(platformUid, session, name);
		accounts.set(platformUid, acc);
		if (name) upsertAccount(name);
		return acc;
	};
	const logout = (platformUid) => {
		accounts.get(platformUid)?.bot.stop();
		accounts.delete(platformUid);
		store.remove(platformUid);
	};
	/**
	* @description 配置变更后应用账号启用状态（配置立即生效）
	*/
	const applyEnable = async (name, enable) => {
		if (!name) return undefined;
		if (!enable) {
			disableAccount(name);
			return undefined;
		}
		return enableAccount(name);
	};
	return {
		store,
		accounts,
		restore,
		login: loginAccount,
		logout,
		applyEnable
	};
}

//#endregion
//#region src/adapter/contact.ts
/** 联系人缓存文件（chatId/secUid 持久化，重启后免重新解析） */
const cacheFile = join(dir.DataDir, "cache", "contact.json");
/** chatId 缓存：`${uid}:${scene}:${peer}` → chatId，入站消息与列表查询回填，按账号隔离 */
const chatCache = new Map();
/** uid → secUid 缓存（用户资料查询入参用；用户属性跨账号一致，全局一份） */
const secUidCache = new Map();
/** 防抖落盘定时器 */
let saveTimer;
function key(uid, scene, peer) {
	return `${uid}:${scene}:${peer}`;
}
/** 变更后合并落盘（防抖 500ms，覆盖入站消息高频写入） */
function saveSoon() {
	if (saveTimer) clearTimeout(saveTimer);
	saveTimer = setTimeout(save, 500);
}
/** 全量落盘：两个缓存平铺写入 JSON */
function save() {
	mkdirSync(join(dir.DataDir, "cache"), { recursive: true });
	writeFileSync(cacheFile, JSON.stringify({
		chat: [...chatCache],
		secUid: [...secUidCache]
	}, null, 2));
}
/** 启动时从磁盘加载联系人缓存（缺失/损坏时静默忽略） */
function loadContactCache() {
	if (!existsSync(cacheFile)) return;
	try {
		const data = JSON.parse(readFileSync(cacheFile, "utf8"));
		for (const [k, v] of data.chat ?? []) chatCache.set(k, v);
		for (const [k, v] of data.secUid ?? []) secUidCache.set(k, v);
	} catch (err) {
		logger.warn(`[douyin] 联系人缓存加载失败: ${err instanceof Error ? err.message : String(err)}`);
	}
}
/** 记录入站消息的会话 chatId 与发送者 secUid（后续发送/撤回/已读复用，无需重新解析） */
function rememberChat(bot, msg) {
	const scene = msg.conversationType === 2 ? "group" : "friend";
	const peer = scene === "group" ? msg.conversationShortId || msg.conversationId : parsePeerFromConversationId(msg.conversationId, bot.id) || msg.senderUid;
	chatCache.set(key(bot.id, scene, peer), msg.chatId);
	if (msg.senderSecUid) secUidCache.set(msg.senderUid, msg.senderSecUid);
	saveSoon();
}
/** 记录 uid → secUid（群成员/陌生人列表回填） */
function rememberSecUid(uid, secUid) {
	if (!secUid) return;
	secUidCache.set(uid, secUid);
	saveSoon();
}
/** 按 uid 查 secUid（用户资料接口入参用） */
function cachedSecUid(uid) {
	return secUidCache.get(uid);
}
/** 全量刷新好友/群列表防漂移（30 分钟定时调用；断线失败静默返回） */
async function refreshContacts(account) {
	const uid = account.platformUid;
	const friends = await account.bot.frd.list().catch(() => undefined);
	if (friends) {
		for (const f of friends) chatCache.set(key(uid, "friend", f.uid), f.chatId);
	}
	const groups = await account.bot.grp.list().catch(() => undefined);
	if (groups) {
		for (const g of groups) {
			chatCache.set(key(uid, "group", g.conversationShortId || g.conversationId), g.chatId);
		}
		for (const member of groups.flatMap((g) => g.members)) rememberSecUid(member.uid, member.secUid);
	}
	saveSoon();
}
/** karin contact → 抖音 chatId：缓存命中直接返回；未命中查好友/群列表匹配并顺带回填 */
async function resolveChatId(account, contact) {
	if (!contact?.peer) return undefined;
	const scene = contact.scene === "group" ? "group" : "friend";
	const cached = chatCache.get(key(account.platformUid, scene, contact.peer));
	if (cached) return cached;
	if (scene === "group") {
		const group = (await account.bot.grp.list().catch(() => [])).find((g) => g.conversationShortId === contact.peer || g.conversationId === contact.peer || g.name === contact.peer);
		if (!group) return undefined;
		chatCache.set(key(account.platformUid, "group", contact.peer), group.chatId);
		for (const member of group.members) rememberSecUid(member.uid, member.secUid);
		saveSoon();
		return group.chatId;
	}
	const friend = (await account.bot.frd.list().catch(() => [])).find((f) => f.uid === contact.peer);
	if (!friend) return undefined;
	chatCache.set(key(account.platformUid, "friend", contact.peer), friend.chatId);
	saveSoon();
	return friend.chatId;
}
/** chatId → 抖音会话地址（复刻 SDK 内部 toAddress；盖楼 `50::threadId` 时 shortId 为空串） */
function chatAddressOf(chatId) {
	const [type, shortId, ...rest] = chatId.split(":");
	const conversationId = rest.join(":");
	if (!type || !conversationId) throw new Error(`[douyin] 非法 chatId: ${chatId}`);
	return {
		conversationId,
		conversationShortId: shortId ?? "",
		conversationType: Number(type)
	};
}

//#endregion
//#region src/adapter/media.ts
/** 幂等挂载标记（跨模块重载防重复挂载） */
const MOUNTED = Symbol.for("karin.douyin.media.mounted");
/** 抖音富媒体代理 URL（挂载在 Karin HTTP 服务下，代理请求携带账号 Cookie + Referer；skey 供代理内解密图片） */
function mediaUrl(uid, url, skey) {
	return `http://127.0.0.1:${config.port()}/dm/${uid}?u=${encodeURIComponent(url)}${skey ? `&k=${skey}` : ""}`;
}
/** AES-256-GCM 解密抖音图片（前 12 字节 IV + 密文 + 后 16 字节 AuthTag，密钥为消息 skey） */
function decryptImage(buf, skey) {
	if (buf.length < 29) return undefined;
	try {
		const d = createDecipheriv("aes-256-gcm", Buffer.from(skey, "hex"), buf.subarray(0, 12));
		d.setAuthTag(buf.subarray(buf.length - 16));
		return Buffer.concat([d.update(buf.subarray(12, buf.length - 16)), d.final()]);
	} catch {
		return undefined;
	}
}
/** 按魔数识别图片类型（转码档为 WebP，origin 档可能为 HEIC） */
function imageContentType(buf) {
	const head = buf.subarray(0, 12).toString("hex");
	if (head.startsWith("ffd8ff")) return "image/jpeg";
	if (head.startsWith("89504e47")) return "image/png";
	if (head.startsWith("52494646") && buf.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
	if (buf.subarray(4, 8).toString("latin1") === "ftyp") return "image/heic";
	if (head.startsWith("474946")) return "image/gif";
	return "application/octet-stream";
}
/** 幂等挂载媒体代理路由：按账号 Cookie 拉取抖音私有资源；带 skey 的图片解密后转发，其余流式转发 */
function mountMediaRoute() {
	const holder = globalThis;
	if (holder[MOUNTED]) return;
	holder[MOUNTED] = true;
	const store = new AccountStore(dir.accountsDir);
	app.use("/dm/:uid", async (req, res) => {
		const url = String(req.query.u ?? "");
		const uid = String(req.params.uid ?? "");
		if (!/^https?:\/\//.test(url)) {
			res.status(400).end("bad url");
			return;
		}
		try {
			const headers = {
				Referer: "https://www.douyin.com/",
				"User-Agent": DESKTOP_PC_UA
			};
			const cookie = store.load(uid)?.cookie;
			if (cookie) headers.Cookie = cookie;
			const upstream = await fetch(url, {
				headers,
				redirect: "follow",
				signal: AbortSignal.timeout(3e4)
			});
			if (!upstream.ok) {
				res.status(upstream.status).end("upstream error");
				return;
			}
			if (!upstream.body) {
				res.status(502).end("empty upstream");
				return;
			}
			const skey = String(req.query.k ?? "");
			if (/^[0-9a-f]{64}$/i.test(skey)) {
				const plain = decryptImage(Buffer.from(await upstream.arrayBuffer()), skey);
				if (!plain) {
					res.status(502).end("decrypt error");
					return;
				}
				res.setHeader("Content-Type", imageContentType(plain));
				res.setHeader("Content-Length", String(plain.length));
				res.end(plain);
				return;
			}
			if (/^[0-9a-f]{32}$/i.test(skey)) {
				const plain = decryptCencMp4(Buffer.from(await upstream.arrayBuffer()), skey);
				res.setHeader("Content-Type", "video/mp4");
				res.setHeader("Content-Length", String(plain.length));
				res.end(plain);
				return;
			}
			const contentType = upstream.headers.get("content-type");
			const contentLength = upstream.headers.get("content-length");
			if (contentType) res.setHeader("Content-Type", contentType);
			if (contentLength) res.setHeader("Content-Length", contentLength);
			Readable.fromWeb(upstream.body).pipe(res);
		} catch (err) {
			logger.error(`[douyin] 媒体代理失败 ${url}:`, err);
			if (!res.headersSent) res.status(502).end("proxy error");
			res.destroy();
		}
	});
	logger.debug("[douyin] 媒体代理已挂载到 Karin HTTP 服务: /dm");
}

//#endregion
//#region src/adapter/convert.ts
/** 合并转发节点缓存：resId（消息 ID）→ 节点，getForwardMsg 供插件拉取 */
const forwardCache = new Map();
/** 引用回复缓存：`${平台uid}:${serverMessageId}` → 入站消息，收消息时缓存、300 秒后过期（对齐参考插件 replys，免查历史） */
const replyCache = new Map();
/** 1x1 JPEG 占位封面（视频发送必需 poster） */
const POSTER_JPEG = Uint8Array.from(Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==", "base64"));
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
/** 记录入站引用的原消息（发送侧引用回复优先取缓存，命中即免查历史） */
function rememberReply(account, msg) {
	if (!msg.serverMessageId) return;
	const key = `${account.platformUid}:${msg.serverMessageId}`;
	replyCache.set(key, msg);
	setTimeout(() => replyCache.delete(key), 3e5).unref();
}
function isObject(v) {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}
function stringArray(v) {
	return Array.isArray(v) ? v.filter((item) => typeof item === "string") : [];
}
/** 从图片资源取可访问 URL（转码档 WebP 优先；无 URL 返回 undefined） */
function pickImage(image) {
	const url = image.largeUrls?.[0] ?? image.mediumUrls?.[0] ?? image.thumbUrls?.[0] ?? image.originUrls?.[0];
	return url ? {
		url,
		skey: image.skey
	} : undefined;
}
/** 复刻 SDK parseBody：wire content + messageType → 收侧消息体（只覆盖参考插件 8 类，其余兜底文本） */
function parseContent(content, messageType) {
	let value;
	try {
		const decoded = JSON.parse(content.replace(/"(\w+)"\s*:\s*(\d{16,})/g, "\"$1\":\"$2\""));
		if (!isObject(decoded)) return {
			type: "unknown",
			text: content,
			raw: content
		};
		value = decoded;
	} catch {
		return {
			type: "text",
			text: content
		};
	}
	const aweType = Number(value["aweType"] ?? value["awe_type"] ?? 0);
	const text = String(value["text"] ?? value["content"] ?? value["display_name"] ?? "");
	if (messageType === 17) {
		const resource = isObject(value["resource_url"]) ? value["resource_url"] : undefined;
		return {
			type: "audio",
			text: text || "[语音]",
			audio: {
				urls: stringArray(resource?.["url_list"]),
				uri: String(resource?.["uri"] ?? "")
			}
		};
	}
	if (messageType === 6 || messageType === 150) {
		return {
			type: "file",
			text: String(value["name"] ?? "") || "[文件]",
			file: {
				uri: String(value["uri"] ?? ""),
				skey: String(value["skey"] ?? ""),
				md5: String(value["md5"] ?? ""),
				name: String(value["name"] ?? ""),
				dataSize: Number(value["data_size"] ?? 0)
			}
		};
	}
	if (messageType === 73 || messageType === 90) return {
		type: "text",
		text: String(value["hint"] ?? "")
	};
	if (messageType === 1 && aweType === 133) return {
		type: "text",
		text: ""
	};
	if (messageType === 136) {
		const summary = Array.isArray(value["list_content"]) ? value["list_content"] : [];
		const refs = Array.isArray(value["msg_ids"]) ? value["msg_ids"] : [];
		const refById = new Map();
		for (const ref of refs) {
			if (isObject(ref)) refById.set(String(ref["msg_id"] ?? ""), ref);
		}
		const nodes = [];
		for (const item of summary) {
			if (!isObject(item)) continue;
			const msgId = String(item["msgid"] ?? "");
			const ref = refById.get(msgId);
			nodes.push({
				uid: String(ref?.["uid"] ?? ""),
				nickname: String(item["nick_name"] ?? ""),
				text: String(item["text"] ?? ""),
				msgType: Number(ref?.["msg_type"] ?? 0),
				aweType: Number(ref?.["awe_type"] ?? 0),
				msgId,
				...ref?.["sec_uid"] ? { secUid: String(ref["sec_uid"]) } : {},
				...ref?.["create_time"] ? { createTime: Number(ref["create_time"]) } : {}
			});
		}
		return {
			type: "forward",
			text: "[合并转发]",
			nodes
		};
	}
	if (messageType === 502) {
		const cover = isObject(isObject(value["cover_info"]) ? value["cover_info"]["resource_url"] : undefined) ? (isObject(value["cover_info"]) ? value["cover_info"] : {})["resource_url"] : undefined;
		return {
			type: "location",
			text: String(value["poi_name"] ?? value["poi_address"] ?? "") || "[位置]",
			location: {
				name: String(value["poi_name"] ?? ""),
				address: String(value["poi_address"] ?? ""),
				latitude: Number(value["latitude"] ?? 0),
				longitude: Number(value["longitude"] ?? 0),
				poiId: String(value["poi_id"] ?? ""),
				awemePoiId: String(value["aweme_poi_id"] ?? ""),
				uri: String(cover?.["uri"] ?? ""),
				urlList: stringArray(cover?.["url_list"])
			}
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
			type: "unknown",
			text,
			raw: value
		};
	}
	const image = imageFromObject(value);
	if (image) return {
		type: "image",
		text: text || "[图片]",
		image
	};
	const videoValue = isObject(value["video"]) ? value["video"] : undefined;
	if (videoValue) {
		const poster = isObject(value["poster"]) ? imageFromObject(value["poster"]) : undefined;
		return {
			type: "video",
			text: text || "[视频]",
			video: {
				tkey: String(videoValue["tkey"] ?? ""),
				skey: String(videoValue["skey"] ?? ""),
				md5: String(videoValue["md5"] ?? ""),
				width: Number(value["width"] ?? 0),
				height: Number(value["height"] ?? 0),
				checkPics: stringArray(value["check_pics"]),
				...poster ? { poster } : {},
				...value["inline_pic"] ? { inlinePic: String(value["inline_pic"]) } : {}
			}
		};
	}
	const emojiUrl = isObject(value["url"]) ? value["url"] : undefined;
	const url = String(emojiUrl?.["uri"] ?? stringArray(emojiUrl?.["url_list"])[0] ?? "");
	if (aweType === 507 || url) return {
		type: "emoji",
		text: text || "[表情]",
		emoji: url
	};
	if (text || "text" in value) {
		const mentions = mentionsFromValue(value);
		if (!mentions) return {
			type: "text",
			text
		};
		const stripped = stripMentions(text, mentions);
		const ats = mentions.sort((a, b) => a.location - b.location).map((m) => ({ uid: m.uid }));
		return {
			type: "text",
			text: stripped || text,
			ats
		};
	}
	return {
		type: "unknown",
		text,
		raw: value
	};
}
/** 复刻 SDK imageFromObject：resource_url 兜底取 value 本身，URL 双来源读取 */
function imageFromObject(value) {
	const resource = isObject(value["resource_url"]) ? value["resource_url"] : value;
	const oid = String(resource["oid"] ?? resource["uri"] ?? "");
	const skey = String(resource["skey"] ?? "");
	const urls = (name) => stringArray(resource[name] ?? value[name]);
	if (!oid && !skey && ![
		"origin_url_list",
		"large_url_list",
		"medium_url_list",
		"thumb_url_list"
	].some((name) => urls(name).some(Boolean))) {
		return undefined;
	}
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
/** 复刻 SDK mentionsFromValue：仅 infoType=1（@ 人）计入，取 uid/location/length */
function mentionsFromValue(value) {
	const infos = value["richTextInfos"];
	if (!Array.isArray(infos) || infos.length === 0) return undefined;
	const mentions = [];
	for (const item of infos) {
		const record = isObject(item) ? item : undefined;
		if (!record || Number(record["infoType"]) !== 1) continue;
		const info = isObject(record["info"]) ? record["info"] : undefined;
		const uid = String(info?.["uid"] ?? "");
		if (!uid) continue;
		mentions.push({
			uid,
			location: Number(record["location"] ?? 0),
			length: Number(record["length"] ?? 0)
		});
	}
	return mentions.length ? mentions : undefined;
}
/** 复刻 SDK stripMentions：按 location/length 从后往前剥离 @ 片段 */
function stripMentions(text, mentions) {
	let rest = text;
	for (const m of [...mentions].sort((a, b) => b.location - a.location)) {
		if (m.location < 0 || m.location + m.length > rest.length) continue;
		rest = rest.slice(0, m.location) + rest.slice(m.location + m.length);
	}
	return rest;
}
/** 收侧消息体 → karin 元素：媒体走鉴权代理，无直链资源按封面/占位还原 */
function bodyToElements(body, uid, resId) {
	switch (body.type) {
		case "text": {
			const segs = [];
			for (const at of body.ats ?? []) {
				if (at.uid) segs.push(segment.at(at.uid));
			}
			return [...segs, segment.text(body.text)];
		}
		case "emoji": return body.emoji ? [segment.image(mediaUrl(uid, body.emoji))] : [segment.text(body.text ?? "")];
		case "image": {
			const img = pickImage(body.image);
			return img ? [segment.image(mediaUrl(uid, img.url, img.skey))] : [];
		}
		case "video": {
			const play = body.video.url?.mainUrl ?? body.video.url?.backupUrl;
			if (play) return [segment.video(mediaUrl(uid, play, body.video.skey))];
			const poster = body.video.poster ? pickImage(body.video.poster) : undefined;
			if (poster) return [segment.image(mediaUrl(uid, poster.url, poster.skey))];
			if (body.video.inlinePic) return [segment.image(body.video.inlinePic)];
			return [];
		}
		case "audio": {
			const url = body.audio.urls[0] ?? "";
			return url ? [segment.record(mediaUrl(uid, url))] : [];
		}
		case "file": return [segment.file(body.file.md5, {
			name: body.file.name,
			size: body.file.dataSize,
			hash: body.file.md5
		})];
		case "forward": {
			if (resId && body.nodes.length) {
				cacheForwardNodes(resId, body.nodes);
				return [segment.longMsg(resId)];
			}
			return [segment.text(body.text || "[合并转发]")];
		}
		default: return [segment.text(body.text || "[未知消息]")];
	}
}
/** 抖音消息 → karin 元素（引用回复前置 reply 元素；收/历史消息共用同一入口） */
function toElements(content, messageType, resId, uid, reference) {
	const body = parseContent(content, messageType);
	const elements = bodyToElements(body, uid, resId);
	if (reference) return [segment.reply(reference.referencedMessageId), ...elements];
	return elements.length ? elements : [segment.text(body.text || "[未知消息]")];
}
/** 历史消息展示摘要（发送侧合并转发节点/引用回复补全用） */
function historySummary(content, messageType) {
	const body = parseContent(content, messageType);
	return body.text || "[未知消息]";
}
/** karin 媒体源 → SDK 可识别输入：剥掉 base64:// 前缀（SDK 只认纯 base64/URL/本地路径） */
function mediaSource(file) {
	return file.startsWith("base64://") ? file.slice(9) : file;
}
/** fake node 元素消息归一化（缺省类型按 text） */
function normalizeNodeMessage(inner) {
	const obj = inner;
	return {
		type: String(obj.type ?? "text"),
		text: obj.text
	};
}
/** nodeDirect 节点补全：查最近历史定位原消息（uid/摘要/类型），失败按占位 */
async function resolveDirectNodes(account, chatId, messageIds) {
	const wanted = new Set(messageIds);
	const nodes = new Map();
	try {
		const history = await account.bot.chat.history(chatId, { count: 60 });
		for (const msg of history) {
			if (!msg.msgId || !wanted.has(msg.msgId)) continue;
			nodes.set(msg.msgId, {
				uid: msg.senderUid,
				nickname: await account.bot.nickOf(msg.senderUid) ?? msg.senderUid,
				text: historySummary(msg.content, msg.msgType),
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
/** 引用回复选项：优先取收消息时缓存的原文（免查历史）；未命中降级查最近 60 条，仍无返回 undefined */
async function makeReplyOptions(account, chatId, referencedMessageId, text) {
	const cached = replyCache.get(`${account.platformUid}:${referencedMessageId}`);
	if (cached) {
		return {
			...chatAddressOf(chatId),
			text,
			referencedMessageId,
			referencedMessageType: cached.messageType ?? 0,
			referencedUid: cached.senderUid,
			...cached.senderSecUid ? { referencedSecUid: cached.senderSecUid } : {},
			nickname: cached.senderNickname ?? "",
			referencedText: cached.text || historySummary(cached.content, cached.messageType ?? 0)
		};
	}
	try {
		const history = await account.bot.chat.history(chatId, { count: 60 });
		const ref = history.find((m) => m.msgId === referencedMessageId);
		if (!ref) return undefined;
		return {
			...chatAddressOf(chatId),
			text,
			referencedMessageId,
			referencedMessageType: ref.msgType,
			referencedUid: ref.senderUid,
			...ref.senderSecUid ? { referencedSecUid: ref.senderSecUid } : {},
			nickname: await account.bot.nickOf(ref.senderUid) ?? "",
			referencedText: historySummary(ref.content, ref.msgType)
		};
	} catch {
		return undefined;
	}
}
/** 发送摘要：text 原样、媒体类型占位（对齐参考插件 makeBrief） */
function makeBrief(body) {
	switch (body.type) {
		case "text": return body.text || "(空)";
		case "image": return "[图片]";
		case "video": return "[视频]";
		case "file": return `[文件:${"name" in body.file ? body.file.name ?? "" : ""}]`;
		case "forward": return `[合并转发:${body.nodes.length}条]`;
		default: return `[${body.type}]`;
	}
}
/** 校验发送响应：非 0 抛错（401/login/expire 提示重登）；成功写中文发送日志 */
function checkSend(account, ret, target, brief) {
	if (ret.statusCode !== 0) {
		if (/401|login|expire/i.test(ret.statusMsg)) {
			logger.error(`[douyin][${account.platformUid}] 登录态失效（${ret.statusMsg}），请重新扫码登录`);
		}
		throw new Error(`[douyin] 发送${brief}失败: ${ret.statusMsg} (code=${ret.statusCode})`);
	}
	logger.info(`[douyin] 发送到 ${target}: ${brief}`);
	return ret;
}
/** 单条发送入口：状态校验 + 结果日志（媒体由 SDK 自动上传） */
async function sendBody(account, chatId, body, target) {
	return checkSend(account, await account.bot.msg.send(chatId, body), target, makeBrief(body));
}
/** 引用回复发送：定位失败降级为普通文本 */
async function sendReply(account, chatId, referencedMessageId, chunk, target) {
	const options = await makeReplyOptions(account, chatId, referencedMessageId, chunk);
	if (!options) return sendBody(account, chatId, {
		type: "text",
		text: chunk
	}, target);
	const ret = await account.bot.im().reply(options);
	return checkSend(account, ret, target, makeBrief({
		type: "text",
		text: chunk
	}));
}
/** 收集合并转发节点：fake（自定义）+ messageID（引用真实消息） */
async function collectForwardNodes(account, chatId, elements) {
	const fakes = [];
	const directs = [];
	for (const el of elements) {
		if (el.type !== "node") continue;
		if (el.subType === "fake") {
			fakes.push({
				userId: el.userId,
				nickname: el.nickname,
				message: el.message.map(normalizeNodeMessage)
			});
		} else if (el.subType === "messageID") {
			directs.push(el.messageId || el.message_id);
		}
	}
	if (!fakes.length && !directs.length) return undefined;
	const directNodes = directs.length ? await resolveDirectNodes(account, chatId, directs.filter(Boolean)) : [];
	return [...buildForwardNodes(fakes, account.platformUid), ...directNodes];
}
/** karin 元素 → 抖音消息：node 合并转发单发；text/at/face 聚合、reply 带引用、媒体逐条发送（对齐参考插件 makeMsg） */
async function makeMsg(account, contact, elements) {
	const chatId = await resolveChatId(account, contact);
	if (!chatId) throw new Error(`[douyin] 无法解析会话目标: ${contact.scene} ${contact.peer}`);
	const target = contact.scene === "group" ? `Group(${contact.peer})` : `User(${contact.peer})`;
	const forwardNodes = await collectForwardNodes(account, chatId, elements);
	if (forwardNodes) {
		const result = await sendBody(account, chatId, {
			type: "forward",
			text: "[合并转发]",
			nodes: forwardNodes
		}, target);
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
	const ats = [];
	const flush = async () => {
		const chunk = text.trim();
		text = "";
		if (!chunk) return;
		if (pendingReplyId) {
			const referenced = pendingReplyId;
			pendingReplyId = "";
			last = await sendReply(account, chatId, referenced, chunk, target);
			return;
		}
		const mentions = ats.splice(0).filter((m) => /^\d+$/.test(m.uid));
		last = await sendBody(account, chatId, {
			type: "text",
			text: chunk,
			...mentions.length ? { ats: mentions } : {}
		}, target);
	};
	for (const el of elements) {
		switch (el.type) {
			case "text":
				text += el.text;
				break;
			case "at":
				ats.push({
					uid: el.targetId,
					nickname: el.name
				});
				break;
			case "face":
				text += `[表情:${el.id}]`;
				break;
			case "reply":
				pendingReplyId = el.messageId;
				break;
			case "image":
				await flush();
				last = await sendBody(account, chatId, {
					type: "image",
					image: mediaSource(el.file)
				}, target);
				break;
			case "video":
				await flush();
				last = await sendBody(account, chatId, {
					type: "video",
					video: {
						source: mediaSource(el.file),
						poster: POSTER_JPEG,
						width: el.width || 720,
						height: el.height || 1280
					}
				}, target);
				break;
			case "record":
				text += "[语音]暂不支持";
				break;
			case "file":
				await flush();
				last = await sendBody(account, chatId, {
					type: "file",
					file: {
						source: mediaSource(el.file),
						name: el.name
					}
				}, target);
				break;
			default: break;
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
//#region src/adapter/index.ts
/** 账号管理器单例 */
let manager;
function getAccountManager() {
	manager ??= createAccountManager();
	return manager;
}
/** ChatMessage → karin MessageResponse（昵称异步查询） */
async function toMessageResponse(ctx, contact, msg) {
	const nick = await ctx.bot.nickOf(msg.senderUid) ?? "";
	return {
		time: msg.createTime,
		messageId: msg.msgId,
		messageSeq: Number(msg.indexInConversation ?? 0),
		contact,
		sender: {
			userId: msg.senderUid,
			nick,
			name: nick,
			role: "member"
		},
		elements: toElements(msg.content, msg.msgType, msg.msgId, ctx.platformUid)
	};
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
		return makeMsg(this.ctx, contact, elements);
	}
	/** 撤回消息 */
	async recallMsg(contact, messageId) {
		const chatId = await this.requireChatId(contact);
		const result = await this.ctx.bot.msg.recall(chatId, messageId);
		if (!result.recalled) logger.warn(`[douyin] 撤回失败: ${result.statusMsg}`);
	}
	/** 消息表情回应：faceId 1-6 为回应面板（爱心/大笑/惊讶/泪奔/赞/抱拳），文本表情键原样透传 */
	async setMsgReaction(contact, messageId, faceId, isSet) {
		const chatId = await this.requireChatId(contact);
		const key = String(faceId);
		let emoji = "";
		if (/^\d+$/.test(key)) {
			for (const base of [dir.defResourcesDir, path.join(dir.pluginDir, "resources")]) {
				const file = path.join(base, "reactions.json");
				if (!fs.existsSync(file)) continue;
				emoji = requireFileSync(file)[key] ?? "";
				break;
			}
		} else {
			emoji = key;
		}
		if (!emoji) throw new Error(`[douyin] 未知的表情回应 faceId: ${faceId}`);
		const result = await this.ctx.bot.msg.react(chatId, messageId, emoji, isSet);
		if (result.statusCode !== 0) logger.warn(`[douyin] 表情回应失败: statusCode=${result.statusCode} ${result.statusMsg}`);
	}
	/** 好友列表（同时回填 secUid，供头像查询复用） */
	async getFriendList() {
		const list = await this.ctx.bot.frd.list();
		for (const f of list) rememberSecUid(f.uid, f.secUid);
		return list.map((f) => ({
			userId: f.uid,
			nick: f.nickname
		}));
	}
	/** 用户昵称：自身取登录资料，他人走 SDK 昵称接口 */
	async getNickname(userId) {
		if (userId === this.account.selfId) {
			return (await this.ctx.bot.user.self()).nickname ?? "";
		}
		return await this.ctx.bot.nickOf(userId) ?? "";
	}
	/** 用户头像：自身取登录资料；他人按 secUid 查对话场景资料。size 对齐官方 0|100|40|140 */
	async getAvatarUrl(userId, size) {
		const uid = userId || this.account.selfId;
		const raw = uid === this.account.selfId ? (await this.ctx.bot.user.self()).avatar ?? "" : await this.peerAvatarUrl(uid);
		const s = size ?? 0;
		return raw && s ? raw.replace(/(~c5_)\d+x\d+/, `$1${s}x${s}`) : raw;
	}
	/** 他人头像：按缓存 secUid 查对话场景资料 */
	async peerAvatarUrl(uid) {
		const secUid = cachedSecUid(uid);
		if (!secUid) return "";
		const profile = await this.ctx.bot.user.profileScene(secUid).catch(() => undefined);
		return profile?.avatar ?? "";
	}
	/** 群列表（同时回填成员 secUid） */
	async getGroupList() {
		const list = await this.ctx.bot.grp.list();
		for (const member of list.flatMap((g) => g.members)) rememberSecUid(member.uid, member.secUid);
		return list.map((g) => ({
			groupId: g.conversationShortId || g.conversationId,
			groupName: g.name,
			memberCount: g.members.length,
			avatar: g.avatar ?? ""
		}));
	}
	/** 群信息（从群列表匹配） */
	async getGroupInfo(groupId) {
		const group = (await this.ctx.bot.grp.list()).find((g) => g.conversationId === groupId || g.conversationShortId === groupId || g.name === groupId);
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
		const group = (await this.ctx.bot.grp.list()).find((g) => g.conversationId === groupId || g.conversationShortId === groupId || g.name === groupId);
		return group?.avatar ?? "";
	}
	/** 群成员列表（secUid 回填供资料查询） */
	async getGroupMemberList(groupId) {
		const chatId = await this.requireChatId({
			scene: "group",
			peer: groupId,
			name: ""
		});
		const members = await this.ctx.bot.grp.members(chatId);
		for (const m of members) rememberSecUid(m.uid, m.secUid);
		return members.map((m) => ({
			userId: m.uid,
			nick: m.nickname || m.alias || m.uid,
			card: m.alias ?? "",
			role: m.role === 1 ? "owner" : m.role === 2 ? "admin" : "member",
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
		const list = await this.ctx.bot.chat.strangers();
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
		const chatId = await this.requireChatId(a);
		const history = await this.ctx.bot.chat.history(chatId);
		const msg = b ? history.find((m) => m.msgId === b) : history[history.length - 1];
		if (!msg) throw new Error(`[douyin] 未找到消息: ${b || "(最近)"}`);
		return toMessageResponse(this.ctx, a, msg);
	}
	/** 获取历史消息：start 为 indexInConversation 游标（或消息 ID），返回 ≤start 的 count 条（时间正序） */
	async getHistoryMsg(contact, start, count) {
		const chatId = await this.requireChatId(contact);
		const limit = count || 1;
		const anchor = typeof start === "object" && start !== null ? start.seq : start;
		let cursor = Number(anchor);
		if (!Number.isFinite(cursor) || cursor <= 0) {
			cursor = 0;
			if (anchor) {
				const recent = await this.ctx.bot.chat.history(chatId);
				cursor = Number(recent.find((m) => m.msgId === String(anchor))?.indexInConversation ?? 0);
			}
		}
		const history = await this.ctx.bot.chat.history(chatId, {
			cursor,
			count: limit
		});
		const sorted = [...history].sort((a, b) => (Number(a.indexInConversation) || 0) - (Number(b.indexInConversation) || 0));
		return Promise.all(sorted.slice(-limit).map((m) => toMessageResponse(this.ctx, contact, m)));
	}
	/** 抖音 HTTP 通道（douyin.ts Bot 内部实例） */
	get http() {
		return this.ctx.bot.http();
	}
	/** 获取账号 Cookie */
	async getCookies() {
		return { cookie: this.http.jar.header() };
	}
	/** 获取 QQ 相关接口凭证（抖音返回 cookie 与 passport csrf token） */
	async getCredentials() {
		const csrf = Number(this.http.jar.get("passport_csrf_token") ?? 0);
		return {
			cookies: this.http.jar.header(),
			csrf_token: Number.isFinite(csrf) ? csrf : 0
		};
	}
	/** 获取 CSRF Token */
	async getCSRFToken() {
		const csrf = Number(this.http.jar.get("passport_csrf_token") ?? 0);
		return { token: Number.isFinite(csrf) ? csrf : 0 };
	}
	/** 解析 karin contact → 抖音 chatId（缓存未命中查好友/群列表） */
	async requireChatId(contact) {
		const chatId = await resolveChatId(this.ctx, contact);
		if (!chatId) throw new Error(`[douyin] 无法解析会话目标: ${contact.scene} ${contact.peer}`);
		return chatId;
	}
	/** 处理好友申请（flag = 申请者 uid） */
	async setFriendApplyResult(flag, isApprove) {
		if (isApprove) await this.ctx.bot.frd.approve(flag);
		else await this.ctx.bot.frd.reject(flag);
	}
	/** 处理入群申请（flag = requestId） */
	async setGroupApplyResult(flag, isApprove) {
		if (isApprove) await this.ctx.bot.grp.approve(flag);
		else await this.ctx.bot.grp.reject(flag);
	}
	/** 设置群名（cmd=902 set_conversation_core_info） */
	async setGroupName(groupId, groupName) {
		const chatId = await this.requireChatId({
			scene: "group",
			peer: groupId,
			name: ""
		});
		const result = await this.ctx.bot.grp.rename(chatId, groupName);
		if (result.statusCode !== 0) {
			throw new Error(`[douyin] 设置群名失败: ${result.statusMsg} (code=${result.statusCode})`);
		}
	}
	/** 群踢人（SDK 成员移除；rejectAddRequest/kickReason 抖音无对等入参，忽略） */
	async groupKickMember(groupId, targetId) {
		const chatId = await this.requireChatId({
			scene: "group",
			peer: groupId,
			name: ""
		});
		const result = await this.ctx.bot.grp.removeMembers(chatId, [targetId]);
		if (result.statusCode !== 0) {
			throw new Error(`[douyin] 群踢人失败: ${result.statusMsg} (code=${result.statusCode})`);
		}
	}
	/** 退出群聊（抖音 Leave 无解散/退出之分，isDismiss 忽略） */
	async setGroupQuit(groupId, _isDismiss) {
		const chatId = await this.requireChatId({
			scene: "group",
			peer: groupId,
			name: ""
		});
		const result = await this.ctx.bot.grp.leave(chatId);
		if (result.statusCode !== 0) {
			throw new Error(`[douyin] 退群失败: ${result.statusMsg} (code=${result.statusCode})`);
		}
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
	/** 抖音入站消息 → karin 消息事件（bind 已补 chatId/senderNickname/视频直链） */
	makeMessage(msg) {
		try {
			if (msg.type === "text" && !msg.text) return;
			rememberChat(this.ctx.bot, msg);
			rememberReply(this.ctx, msg);
			const messageId = msg.serverMessageId || `${msg.cmd}-${msg.indexInConversationV2 ?? msg.indexInConversation ?? Date.now()}`;
			const elements = toElements(msg.content, msg.messageType, messageId, this.ctx.platformUid, msg.reference);
			const seq = Number(msg.indexInConversationV2 || msg.indexInConversation || msg.serverMessageId || 0) || Math.floor(Date.now() / 1e3);
			const time = Number(msg.createTime) > 0 ? Math.floor(Number(msg.createTime) / 1e3) : Math.floor(Date.now() / 1e3);
			const nick = msg.senderNickname;
			if (msg.conversationType === 2) {
				const peer = msg.conversationShortId || msg.conversationId;
				const contact = contactGroup(peer);
				createGroupMessage({
					bot: this,
					contact,
					elements,
					eventId: messageId,
					messageId,
					messageSeq: seq,
					rawEvent: msg.raw,
					sender: senderGroup(msg.senderUid, "member", nick),
					time,
					srcReply: (elems) => this.sendMsg(contact, elems)
				});
			} else {
				const peer = parsePeerFromConversationId(msg.conversationId, this.ctx.platformUid) || msg.senderUid;
				const contact = contactFriend(peer, nick);
				createFriendMessage({
					bot: this,
					contact,
					elements,
					eventId: messageId,
					messageId,
					messageSeq: seq,
					rawEvent: msg.raw,
					sender: senderFriend(msg.senderUid, nick),
					time,
					srcReply: (elems) => this.sendMsg(contact, elems)
				});
			}
		} catch (err) {
			logger.error("[douyin] 处理入站消息失败:", err);
		}
	}
	/** 抖音通知事件 → karin 通知事件 */
	makeNotice(ev) {
		try {
			switch (ev.type) {
				case "message.reaction": {
					const faceId = emojiToFaceId(ev.emoji);
					logger.info(`[douyin] 表情回应: msgId=${ev.serverMessageId} emoji=${ev.emoji} ` + `operator=${ev.operatorUid} isSet=${ev.isSet}`);
					if (!ev.conversationId.startsWith("0:2:")) return;
					const contact = contactGroup(ev.conversationId.split(":")[2] || ev.conversationId);
					createGroupMessageReactionNotice({
						...common(this, ev.raw),
						contact,
						sender: senderGroup(ev.operatorUid, "member"),
						srcReply: (elems) => this.sendMsg(contact, elems),
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
						...common(this, ev.raw),
						contact,
						sender: senderFriend(ev.peerUid),
						srcReply: (elems) => this.sendMsg(contact, elems)
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
					const operatorId = ev.recallUid ?? "";
					if (ev.conversationType === 2) {
						const contact = contactGroup(ev.conversationId.split(":")[2] || ev.conversationId);
						createGroupRecallNotice({
							...common(this, ev.raw),
							contact,
							sender: senderGroup(operatorId, "member"),
							srcReply: (elems) => this.sendMsg(contact, elems),
							content: {
								operatorId,
								targetId: operatorId,
								messageId,
								tip: ""
							}
						});
					} else {
						const peer = parsePeerFromConversationId(ev.conversationId, this.selfId) || ev.conversationId;
						const contact = contactFriend(peer);
						createPrivateRecallNotice({
							...common(this, ev.raw),
							contact,
							sender: senderFriend(peer),
							srcReply: (elems) => this.sendMsg(contact, elems),
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
						...common(this, ev.raw),
						contact,
						srcReply: (elems) => this.sendMsg(contact, elems)
					};
					for (const member of ev.members) {
						claimMemberChange(`${groupPeerOf(ev.conversationId)}:${member.uid}:increase`);
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
						...common(this, ev.raw),
						contact,
						srcReply: (elems) => this.sendMsg(contact, elems)
					};
					for (const member of ev.members) {
						claimMemberChange(`${groupPeerOf(ev.conversationId)}:${member.uid}:decrease`);
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
						...common(this, ev.raw),
						contact,
						srcReply: (elems) => this.sendMsg(contact, elems)
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
				case "conversation.typing":
					logger.debug(`[douyin] 输入状态: ${ev.peerUid} typing=${ev.typing}`);
					return;
				case "group.name-change":
					logger.info(`[douyin] 群名变更: ${ev.conversationShortId} 新名=${ev.name ?? "(未知)"}`);
					return;
				case "group.avatar-change":
					logger.info(`[douyin] 群头像变更: ${ev.conversationShortId}`);
					return;
				default: logger.debug("[douyin] 未处理通知:", ev.type);
			}
		} catch (err) {
			logger.error("[douyin] 处理通知事件失败:", err);
		}
	}
	/** 会话状态事件 → karin 通知事件（补漏：部分群成员增减服务端仅下发 status，无系统消息） */
	makeStatus(ev) {
		try {
			if (ev.commandType !== 7) {
				logger.debug(`[douyin][${this.ctx.platformUid}] 会话状态变更: ${ev.conversationId} cmd=${ev.commandType}`);
				return;
			}
			const change = ev.memberChange;
			if (!change) return;
			const peer = groupPeerOf(ev.conversationId);
			const contact = contactGroup(peer);
			const base = {
				...common(this, ev.raw),
				contact,
				srcReply: (elems) => this.sendMsg(contact, elems)
			};
			for (const uid of change.added ?? []) {
				if (isSelfUid(this.ctx.platformUid, uid)) {
					logger.info(`[douyin] 机器人加入群聊: ${peer}`);
					continue;
				}
				if (!claimMemberChange(`${peer}:${uid}:increase`)) continue;
				createGroupMemberAddNotice({
					...base,
					sender: senderGroup(uid, "member"),
					content: {
						operatorId: "",
						targetId: uid,
						type: "invite"
					}
				});
			}
			for (const uid of change.removed ?? []) {
				if (isSelfUid(this.ctx.platformUid, uid)) {
					logger.info(`[douyin] 机器人退出群聊: ${peer}`);
					continue;
				}
				if (!claimMemberChange(`${peer}:${uid}:decrease`)) continue;
				createGroupMemberDelNotice({
					...base,
					sender: senderGroup(uid, "member"),
					content: {
						operatorId: "",
						targetId: uid,
						type: "leave"
					}
				});
			}
		} catch (err) {
			logger.error("[douyin] 处理会话状态事件失败:", err);
		}
	}
	/**
	* @description SDK 独有能力透传（karin 无标准接口的方法，插件可通过 e.bot.xxx 直接调用）
	* @remarks 方法与参考插件挂载面对齐；无返回值的签名由 SDK 类型推导
	*/
	sendTyping(chatId, typing = true) {
		return this.ctx.bot.msg.sendTyping(chatId, typing);
	}
	addGroupMembers(chatId, uids) {
		return this.ctx.bot.grp.addMembers(chatId, uids);
	}
	getGroupRequests(chatId) {
		return this.ctx.bot.grp.requests(chatId);
	}
	createGroup(options) {
		return this.ctx.bot.grp.create(options);
	}
	getChatInfo(chatId) {
		return this.ctx.bot.chat.info(chatId);
	}
	deleteChat(chatId) {
		return this.ctx.bot.chat.delete(chatId);
	}
	setChatSetting(chatId, input) {
		return this.ctx.bot.chat.setting(chatId, input);
	}
	readSwitch(chatId, msgs) {
		return this.ctx.bot.chat.readSwitch(chatId, msgs);
	}
	getReadIndex(chatId) {
		return this.ctx.bot.chat.readIndex(chatId);
	}
	getMinIndex(chatId) {
		return this.ctx.bot.chat.minIndex(chatId);
	}
	getStrangers() {
		return this.ctx.bot.chat.strangers();
	}
	getStrangerConversations() {
		return this.ctx.bot.chat.strangerConversations();
	}
	getOnlineStatus(secUserIds, source) {
		return this.ctx.bot.user.onlineStatus(secUserIds, source);
	}
	heartbeat() {
		return this.ctx.bot.user.heartbeat();
	}
	activeSwitch() {
		return this.ctx.bot.user.activeSwitch();
	}
	getEmojiList() {
		return this.ctx.bot.media.emojiList();
	}
	getVideoUrl(tkey) {
		return this.ctx.bot.media.videoUrl(tkey);
	}
	uploadImage(input) {
		return this.ctx.bot.media.image(input);
	}
	uploadVideo(input) {
		return this.ctx.bot.media.video(input);
	}
	uploadMedia(input, name) {
		return this.ctx.bot.media.file(input, name);
	}
	getAwemeDetail(awemeIds, options) {
		return this.ctx.bot.media.awemeDetail(awemeIds, options);
	}
	/** 抖音请求事件 → karin 请求事件 */
	async makeRequest(ev) {
		try {
			if (ev.type === "friend.request") {
				const contact = contactFriend(ev.applicantUid);
				createPrivateApplyRequest({
					bot: this,
					subEvent: "friendApply",
					contact,
					sender: senderFriend(ev.applicantUid),
					eventId: `douyin-friend-request-${ev.applicantUid}-${Date.now()}`,
					rawEvent: ev.raw,
					time: Math.floor(Date.now() / 1e3),
					srcReply: (elems) => this.sendMsg(contact, elems),
					content: {
						applierId: ev.applicantUid,
						message: ev.content ?? "",
						flag: ev.applicantUid
					}
				});
				return;
			}
			const chatId = chatIdOf({
				conversationId: ev.conversationId,
				conversationShortId: ev.conversationShortId,
				conversationType: ev.conversationType
			});
			const list = await this.ctx.bot.grp.requests(chatId);
			const pending = ev.requestId ? list.find((r) => r.requestId === ev.requestId) : list.find((r) => r.status === 1);
			if (!pending) {
				logger.debug("[douyin] 入群申请审核列表未命中，忽略");
				return;
			}
			const contact = contactGroup(ev.conversationShortId || ev.conversationId);
			createGroupApplyRequest({
				bot: this,
				subEvent: "groupApply",
				contact,
				sender: senderGroup(pending.applicantUid, "member"),
				eventId: `douyin-group-request-${pending.requestId}-${Date.now()}`,
				rawEvent: ev.raw,
				time: Math.floor(Date.now() / 1e3),
				srcReply: (elems) => this.sendMsg(contact, elems),
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
};
/** 当前秒级时间戳 */
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
/** 群成员变更去重表：`${群id}:${uid}:${增加|减少}` → 派发时间戳（status 与 notice 双通道会各自下发同一变更） */
const memberSeen = new Map();
/** 记录并返回是否为窗口期内首次（2 分钟内视为同一变更已派发过，仅 status 通道在派发前检查） */
function claimMemberChange(key) {
	const seen = memberSeen.get(key);
	if (seen && Date.now() - seen < 12e4) return false;
	memberSeen.set(key, Date.now());
	if (memberSeen.size > 500) memberSeen.clear();
	return true;
}
/** 群会话 ID（`0:2:{群id}`）→ 群 id；status 的 conversationId 可能为纯群 id，原样兜底 */
function groupPeerOf(conversationId) {
	return conversationId.startsWith("0:2:") ? conversationId.slice(4) : conversationId;
}
/** bot 自身 uid 判定：SDK 大数无精度保护，尾部可能截 0，前 15 位比对兜底 */
function isSelfUid(selfUid, uid) {
	return uid === selfUid || uid.length === selfUid.length && uid.slice(0, 15) === selfUid.slice(0, 15);
}
/** karin 标准接口中抖音平台不支持的方法名（按名称批量绑定报错 stub，对齐参考插件简洁写法） */
const UNSUPPORTED = [
	"setInvitedJoinGroupResult",
	"sendLike",
	"pokeUser",
	"createResId",
	"sendForwardMsg",
	"sendLongMsg",
	"setGroupMute",
	"setGroupAllMute",
	"setGroupCard",
	"setGroupAdmin",
	"setGroupMemberTitle",
	"setGroupSpecialTitle",
	"setGroupNotice",
	"delGroupNotice",
	"setEssenceMsg",
	"deleteEssenceMsg",
	"getGroupHighlights",
	"setGroupPortrait",
	"setGroupRemark",
	"getGroupHonor",
	"getNotJoinedGroupInfo",
	"getGroupMuteList",
	"getGroupAtAllRemain",
	"getAtAllCount",
	"uploadFile",
	"uploadGroupFile",
	"uploadPrivateFile",
	"downloadFile",
	"getFileUrl",
	"getPrivateFileUrl",
	"getRkey",
	"getGroupFileList",
	"getGroupFileSystemInfo",
	"getGroupFileUrl",
	"getGroupRootFiles",
	"getGroupFilesByFolder",
	"createGroupFileFolder",
	"deleteGroupFile",
	"deleteGroupFolder",
	"renameGroupFolder",
	"moveGroupFile",
	"setAvatar",
	"deleteFriend",
	"deleteUnidirectionalFriend",
	"getUnidirectionalFriendList",
	"sendGroupSign",
	"sendGroupAiRecord",
	"sendAiCharacter",
	"getAiCharacters",
	"ocrImage",
	"getImage",
	"getRecord",
	"getWordSlices",
	"fetchCustomFace",
	"getGroupSystemMsg"
];
/** 打印不支持日志并抛错（模块级函数，供批量绑定 stub 调用） */
function unsupported(method) {
	logger.error(`[douyin] 不支持的操作: ${method}（抖音平台无此能力）`);
	throw new Error(`[douyin] 抖音平台不支持: ${method}`);
}
for (const name of UNSUPPORTED) {
	Object.defineProperty(AdapterDouyin.prototype, name, {
		value: () => unsupported(name),
		writable: true,
		configurable: true
	});
}
/** 已注册 bot 索引：platformUid → 适配器实例 */
const bots = new Map();
/** 主动停用的账号：关闭连接时不再提示重连（SDK stop 同样会触发 close 事件） */
const manualStop = new Set();
/** 好友/群列表防漂移刷新定时器：platformUid → timer */
const refreshTimers = new Map();
/** 启动 30 分钟好友/群列表周期刷新（防群名/成员漂移），断线期间失败仅告警一次 */
function startRefreshTimer(ctx) {
	stopRefreshTimer(ctx.platformUid);
	const timer = setInterval(() => {
		refreshContacts(ctx).catch((err) => logger.warn(`[douyin][${ctx.platformUid}] 联系人列表刷新失败: ${err instanceof Error ? err.message : String(err)}`));
	}, 30 * 60 * 1e3);
	refreshTimers.set(ctx.platformUid, timer);
}
/** 停止账号的周期刷新定时器 */
function stopRefreshTimer(uid) {
	const timer = refreshTimers.get(uid);
	if (timer) clearInterval(timer);
	refreshTimers.delete(uid);
}
let autoReadRegistered = false;
/** 注册「匹配到相应插件自动已读」全局钩子（幂等，仅注册一次；不阻塞插件执行） */
function setupAutoRead() {
	if (autoReadRegistered) return;
	autoReadRegistered = true;
	hooks.eventCall((e, _plugin, next) => {
		if (e.event === "message" && config$1().autoReadOnMatch) {
			const bot = e.bot;
			if (bot?.ctx?.bot) autoReadConversation(bot, e.contact);
		}
		next();
	}, { priority: 100 });
}
/** 自动已读单个会话：解析 chatId 后调用 SDK 已读接口（失败仅 debug） */
async function autoReadConversation(bot, contact) {
	try {
		const chatId = await resolveChatId(bot.ctx, contact);
		if (!chatId) return;
		const result = await bot.ctx.bot.msg.read(chatId);
		if (result.statusCode !== 0) {
			logger.warn(`[douyin] 自动已读失败: statusCode=${result.statusCode} ${result.statusMsg}`);
		}
	} catch (err) {
		logger.debug(`[douyin] 自动已读异常: ${err instanceof Error ? err.message : String(err)}`);
	}
}
/** 注册单个账号为 karin bot：绑定事件、注册、启动 WS 接收 */
async function createBot(ctx) {
	const prev = bots.get(ctx.platformUid);
	if (prev) await destroyBot(prev);
	const bot = new AdapterDouyin(ctx);
	ctx.bot.on("message", (msg) => bot.makeMessage(msg));
	ctx.bot.on("message:edited", (msg) => bot.makeMessage(msg));
	ctx.bot.on("notice", (ev) => bot.makeNotice(ev));
	ctx.bot.on("request", (ev) => bot.makeRequest(ev));
	ctx.bot.on("read", (ev) => logger.debug(`[douyin][${ctx.platformUid}] 已读回执: ${ev.conversationId}`));
	ctx.bot.on("status", (ev) => bot.makeStatus(ev));
	ctx.bot.on("voip", (ev) => logger.debug(`[douyin][${ctx.platformUid}] 语音来电: ${ev.callerUid}`));
	ctx.bot.on("reconnecting", (ev) => {
		if (!manualStop.has(ctx.platformUid)) {
			logger.warn(`[douyin][${ctx.platformUid}] 连接断开，第 ${ev.attempt} 次重连（${ev.delayMs}ms 后）`);
		}
	});
	ctx.bot.on("close", (ev) => {
		if (manualStop.has(ctx.platformUid)) {
			logger.debug(`[douyin][${ctx.platformUid}] 连接已关闭（主动操作）`);
			return;
		}
		logger.warn(`[douyin][${ctx.platformUid}] 连接被断开（${ev.reason || ev.code || "未知原因"}），SDK 自动重连中`);
	});
	bots.set(ctx.platformUid, bot);
	manualStop.delete(ctx.platformUid);
	try {
		await ctx.bot.start();
	} catch (err) {
		bots.delete(ctx.platformUid);
		const reason = err instanceof Error ? err.message : String(err);
		throw new Error(/cookie/i.test(reason) ? `Cookie 已失效，请重新扫码登录（${ctx.config.name || ctx.platformUid}）` : reason);
	}
	bot.adapter.index = registerBot("webSocketClient", bot);
	ctx.bot.user.heartbeat().catch((err) => logger.debug(`[douyin] 心跳上报失败: ${err instanceof Error ? err.message : String(err)}`));
	startRefreshTimer(ctx);
	logger.debug(`[douyin] 账号 ${ctx.platformUid}(${ctx.config.name || "未命名"}) 已上线`);
	return bot;
}
/** 卸载 bot：断开连接、停止周期刷新并从 karin 注销 */
async function destroyBot(bot) {
	manualStop.add(bot.ctx.platformUid);
	stopRefreshTimer(bot.ctx.platformUid);
	bots.delete(bot.ctx.platformUid);
	bot.ctx.bot.stop();
	unregisterBot("selfId", bot.account.selfId);
	logger.debug(`[douyin] 账号 ${bot.ctx.platformUid} 已卸载`);
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
/**
* @description 对比新旧配置中账号启用状态，变更时立即停用/启用对应 bot（配置立即生效）
*/
async function applyAccountEnable(oldCfg, newCfg) {
	const m = getAccountManager();
	const oldMap = new Map((oldCfg.accounts || []).map((a) => [a.name ?? "", a.enable !== false]));
	const newMap = new Map((newCfg.accounts || []).map((a) => [a.name ?? "", a.enable !== false]));
	for (const [name, enable] of newMap) {
		if (!name || oldMap.get(name) === enable) continue;
		if (enable) {
			if (getBots().some((b) => b.ctx.config.name === name)) {
				await m.applyEnable(name, true);
				continue;
			}
			const acc = await m.applyEnable(name, true);
			if (acc) {
				await createBot(acc).catch((err) => logger.error(`[douyin] 启用账号失败 ${name}: ${err instanceof Error ? err.message : String(err)}`));
			}
		} else {
			const bot = getBots().find((b) => b.ctx.config.name === name);
			if (bot) await destroyBot(bot);
			await m.applyEnable(name, false);
		}
	}
}
/**
* @description 注册配置变更监听：账号启用/停用保存后立即生效（幂等）
* @remarks autoReadOnMatch 每次消息实时读取配置，本身即热生效，无需处理
*/
function setupConfigHotApply() {
	onConfigChange((oldCfg, nowCfg) => {
		applyAccountEnable(oldCfg, nowCfg);
	});
}
/** 启动适配器：挂载媒体代理、恢复配置中启用的账号并注册 */
async function initAdapter() {
	mountMediaRoute();
	setupAutoRead();
	setupConfigHotApply();
	loadContactCache();
	const m = getAccountManager();
	await m.restore();
	await Promise.all([...m.accounts.values()].map(async (ctx) => {
		try {
			await createBot(ctx);
		} catch (err) {
			logger.error(`[douyin] 账号初始化失败: ${err instanceof Error ? err.message : String(err)}`);
		}
	}));
}
/** 扫码登录并注册适配器（供指令层调用） */
async function login$1(options = {}) {
	const ctx = await getAccountManager().login(options);
	await createBot(ctx);
	return ctx;
}

//#endregion
export { login$1 as a, initAdapter as i, getAccountManager as n, getBots as r, destroyBot as t };