import { dir } from "./dir.js";
import { n as initAdapter } from "./adapter-DiA-vGJo.js";
import { logger } from "node-karin";

//#region src/index.ts
logger.info(`${logger.violet(`[插件:${dir.version}]`)} ${logger.green(dir.name)} 初始化完成~`);
/** 恢复已登录账号并注册适配器 */
initAdapter().catch((err) => logger.error("[douyin] 适配器初始化失败:", err));

//#endregion
export {  };