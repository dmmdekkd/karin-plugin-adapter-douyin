# Changelog

## [1.2.1](https://github.com/dmmdekkd/karin-plugin-adapter-douyin/compare/v1.2.0...v1.2.1) (2026-10-02)


### Bug Fixes

* ck 失效时零噪音下线，不注册 bot ([5e0c66c](https://github.com/dmmdekkd/karin-plugin-adapter-douyin/commit/5e0c66cfdc250476e7f4316ef8225605e5f9b78f))
* cookie 失效时不注册 bot（start 后主动校验 user.self，initAdapter 逐个容错） ([1b98a95](https://github.com/dmmdekkd/karin-plugin-adapter-douyin/commit/1b98a959601bcc4ae1a1bf07ac0e0649136f88a8))
* 修复适配器初始化失败（registerBot 包装 sendForwardMsg 时对只读 stub 赋值报错） ([f721fb1](https://github.com/dmmdekkd/karin-plugin-adapter-douyin/commit/f721fb1969f9d81e32d0930ca0c44504b4c75ee4))

## [1.2.0](https://github.com/dmmdekkd/karin-plugin-adapter-douyin/compare/v1.1.0...v1.2.0) (2026-10-02)


### Features

* 完善抖音适配器功能（status 群成员变更补漏、SDK 独有能力透传、账号管理指令、登录心跳上报） ([c1bd927](https://github.com/dmmdekkd/karin-plugin-adapter-douyin/commit/c1bd927f70beb8669ce7f1e6dbf8cabdf80e4b19))

## [1.0.0](https://github.com/dmmdekkd/karin-plugin-adapter-douyin/compare/v1.0.0...v1.0.0) (2026-09-17)


### Features

* add auto-read on match, config hot reload and webui support ([c93498e](https://github.com/dmmdekkd/karin-plugin-adapter-douyin/commit/c93498e108e03198e19a18574ff44a9d197e69be))


### Bug Fixes

* repository 指向实际仓库以通过 npm provenance 校验 ([5977918](https://github.com/dmmdekkd/karin-plugin-adapter-douyin/commit/5977918ee8455b1cecd087430fb572ca7859e337))

## [1.0.0](https://github.com/dmmdekkd/karin-plugin-adapter-douyin/compare/v1.0.0...v1.0.0) (2026-09-14)


### Bug Fixes

* repository 指向实际仓库以通过 npm provenance 校验 ([5977918](https://github.com/dmmdekkd/karin-plugin-adapter-douyin/commit/5977918ee8455b1cecd087430fb572ca7859e337))

## [1.0.0](https://github.com/dmmdekkd/karin-plugin-adapter-douyin/compare/v1.0.0...v1.0.0) (2026-09-14)


### Bug Fixes

* repository 指向实际仓库以通过 npm provenance 校验 ([5977918](https://github.com/dmmdekkd/karin-plugin-adapter-douyin/commit/5977918ee8455b1cecd087430fb572ca7859e337))

## [1.0.0](https://github.com/dmmdekkd/karin-plugin-adapter-douyin/compare/v1.0.0...v1.0.0) (2026-09-14)


### Features

* **抖音适配器:** add auto update and manual update functions ([0e501cc](https://github.com/dmmdekkd/karin-plugin-adapter-douyin/commit/0e501cc40a19f659b14e5d9a838259708d691432))
