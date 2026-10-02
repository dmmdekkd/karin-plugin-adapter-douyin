import { n as getAccountManager, r as getBots, t as destroyBot } from "../adapter-DLTqWjAK.js";
import karin from "node-karin";

//#region src/apps/account.ts
/**
* #抖音状态 / #抖音退出登录 账号管理指令
*
* 仅主人可用。
* - #抖音状态：列出所有已登录的抖音账号（在线/离线）
* - #抖音退出登录 [昵称或uid]：下线账号并删除本地会话；无参数且仅一个在线账号时直接退出
*/
/** #抖音状态：账号列表（在线/离线） */
const douyinStatus = karin.command(/^#(?:抖音状态)$/i, async (e) => {
	const online = getBots();
	const records = getAccountManager().store.list();
	if (!records.length) {
		await e.reply("暂无已登录的抖音账号，请先发送 #抖音bot登录");
		return;
	}
	const lines = records.map((r) => {
		const hit = online.find((b) => b.ctx.platformUid === r.platformUid);
		return `${r.screenName || r.platformUid}（${r.platformUid}）· ${hit ? "在线" : "离线"}`;
	});
	await e.reply(lines.join("\n"));
}, {
	name: "douyin:status",
	permission: "master",
	authFailMsg: "#抖音状态 仅限主人使用"
});
/** #抖音退出登录：下线账号并删除本地会话 */
const douyinLogout = karin.command(/^#(?:抖音退出登录)\s*(.*)$/i, async (e) => {
	const keyword = e.msg.replace(/^#抖音退出登录/i, "").trim();
	const bots = getBots();
	if (!bots.length) {
		await e.reply("当前没有在线的抖音账号");
		return;
	}
	const target = keyword ? bots.find((b) => b.ctx.config.name === keyword || b.ctx.platformUid === keyword) : bots.length === 1 ? bots[0] : undefined;
	if (!target) {
		const names = bots.map((b) => `· ${b.ctx.config.name || b.ctx.platformUid}`).join("\n");
		await e.reply(`未找到匹配的在线账号，请指定一个（昵称或 uid）：\n${names}`);
		return;
	}
	await destroyBot(target);
	getAccountManager().logout(target.ctx.platformUid);
	await e.reply(`已退出登录：${target.ctx.config.name || target.ctx.platformUid}（本地会话已删除）`);
}, {
	name: "douyin:logout",
	permission: "master",
	authFailMsg: "#抖音退出登录 仅限主人使用"
});

//#endregion
export { douyinLogout, douyinStatus };