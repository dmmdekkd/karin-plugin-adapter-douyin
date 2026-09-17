import { i as loginByQr, r as logoutBot, t as getBots } from "../adapter-VJUmx-M9.js";
import karin, { logger, segment } from "node-karin";
import QRCode from "qrcode";

//#region src/apps/login.ts
/**
* #抖音登录 / #抖音验证 指令
*
* 仅主人可用。流程：
* 1. 回复提示 → 获取二维码并推送图片
* 2. 扫码确认；若触发短信二次验证，回复「#抖音验证 验证码」提交
* 3. 成功后自动落盘会话并注册 bot
*/
/** 互斥锁：避免并发扫码 */
let busy = false;
/** 等待用户输入短信验证码的回调 */
let mfaWaiter;
const douyinLogin = karin.command(/^#(?:抖音登录|douyinlogin)$/i, async (e) => {
	if (busy) {
		await e.reply("已有扫码登录在进行中，请稍候再试");
		return;
	}
	busy = true;
	try {
		await e.reply("请使用抖音 APP 扫描二维码完成登录（2 分钟内有效）：");
		const acc = await loginByQr({
			onQr: async (info) => {
				if (e.bot.adapter.name === "@karinjs/console") {
					const terminal = await QRCode.toString(info.qrcodeIndexUrl ?? info.token, {
						type: "terminal",
						small: true
					});
					logger.info(`\n${terminal}\n请使用抖音 APP 扫码登录`);
					return;
				}
				const elements = [segment.image(info.qrcodeBase64)];
				if (info.qrcodeIndexUrl) elements.push(segment.text(`或在浏览器打开链接扫码：${info.qrcodeIndexUrl}`));
				Promise.resolve(e.reply(elements)).catch((err) => logger.warn("[douyin] 推送二维码失败:", err));
			},
			onStatus: (status) => {
				if (status === "scanned") {
					Promise.resolve(e.reply("已扫码，请在手机上确认登录")).catch(() => {});
				} else if (status !== "new" && status !== "verifying" && status !== "verified" && status !== "confirmed" && status !== "expired") {
					Promise.resolve(e.reply(status)).catch(() => {});
				}
			},
			onVerifyUrl: (url) => {
				Promise.resolve(e.reply(`触发登录安全验证，请在浏览器打开链接完成（5 分钟内有效）：\n${url}\n若服务部署在远程，请将 127.0.0.1 替换为服务器地址`)).catch(() => {});
			},
			onMfa: async ({ maskedMobile, kind }) => {
				const prompt = kind === "password" ? "触发密码二次验证，请回复「#抖音验证 账号密码」（5 分钟内有效）" : `触发二次验证，验证码已发送至安全手机 ${maskedMobile ?? ""}，请回复「#抖音验证 验证码」（5 分钟内有效）`;
				await e.reply(prompt);
				return new Promise((resolve, reject) => {
					const timer = setTimeout(() => {
						if (mfaWaiter === resolve) mfaWaiter = undefined;
						reject(new Error(kind === "password" ? "等待密码输入超时" : "等待验证码输入超时"));
					}, 5 * 6e4);
					mfaWaiter = (code) => {
						clearTimeout(timer);
						resolve(code);
					};
				});
			}
		});
		await e.reply(`抖音账号 ${acc.platformUid}${acc.config.name ? `(${acc.config.name})` : ""} 登录成功`);
	} catch (err) {
		logger.error("[douyin] 扫码登录失败:", err);
		await e.reply(`扫码登录失败：${err instanceof Error ? err.message : "详见服务端日志"}`);
	} finally {
		busy = false;
		mfaWaiter = undefined;
	}
}, {
	name: "douyin:login",
	permission: "master",
	authFailMsg: "#抖音登录 仅限主人使用"
});
/** 提交扫码二次验证（短信验证码或账号密码） */
const douyinVerify = karin.command(/^#(?:抖音验证|douyinverify)\s+(\S+)$/i, async (e) => {
	if (!mfaWaiter) {
		await e.reply("当前没有等待输入的扫码二次验证");
		return;
	}
	const waiter = mfaWaiter;
	mfaWaiter = undefined;
	waiter(e.msg.match(/^#(?:抖音验证|douyinverify)\s+(\S+)$/i)?.[1] ?? "");
	await e.reply("验证输入已提交，请稍候…");
}, {
	name: "douyin:verify",
	permission: "master",
	authFailMsg: "#抖音验证 仅限主人使用"
});
const LOGOUT_RE = /^#(?:抖音下线|douyinlogout)(?:\s+(\S+))?$/i;
/** 下线账号并卸载 bot（不带参数时下线全部） */
const douyinLogout = karin.command(LOGOUT_RE, async (e) => {
	const target = e.msg.match(LOGOUT_RE)?.[1];
	const online = getBots();
	if (!online.length) {
		await e.reply("当前没有在线的抖音账号");
		return;
	}
	const targets = target ? online.filter((b) => b.ctx.platformUid === target || b.account.name === target) : online;
	if (!targets.length) {
		await e.reply(`未找到账号 ${target}，在线账号: ${online.map((b) => b.account.name || b.ctx.platformUid).join(", ")}`);
		return;
	}
	for (const bot of targets) await logoutBot(bot.ctx.platformUid);
	await e.reply(`已下线: ${targets.map((b) => b.account.name || b.ctx.platformUid).join(", ")}（会话已保留，重启后自动恢复）`);
}, {
	name: "douyin:logout",
	permission: "master",
	authFailMsg: "#抖音下线 仅限主人使用"
});

//#endregion
export { douyinLogin, douyinLogout, douyinVerify };