# 100milionseek

一个给 [magpie](https://usemagpie.ai) 用的 [100milionseek](https://100milionseek.top)
供应商插件。100milionseek 给每个 key 每天 **1 亿 token** 的免费
**DeepSeek V4.1 Flash** 额度。

比手写一个 `providers.json` 条目多做的几件事：

- **真的去读每日额度。** 这个服务只在 `x-quota-*` 响应头里说还剩多少，所以
  `usage` 钩子会发一次请求、把响应头变成 magpie 显示的用量窗口。不编数字：读不到
  就不显示百分比，而不是显示 0%。
- **给得出正确的重置时间。** 额度用完后服务返回 429 但不带 `Retry-After`，插件用
  重置时刻补上一个，于是这个 key 会歇到 UTC 00:00，而不是 magpie 默认的猜测。
- **把判定模型当分类器用。** `jev-1.13-free` 是 System One 模型（`POST
  /v1/systemone`，每个问题一个概率）。插件把它的回答改写成 magpie 读的形状，于是
  它就能给[路由组](https://usemagpie.ai/docs/zh/plugins#decide)做判断。
- **实时负载。** 每两分钟读一次 `/api/status`，把上游的 inflight/capacity 比例按
  模型报给 magpie，*设置 › 模型 › 路由 › 繁忙的模型靠后* 就能把请求挪开一个挤爆的
  中转站。

## 安装

```sh
magpie plugin add ./100milionseek
# 发布到 npm 之后：magpie plugin add 100milionseek
magpie plugin login hundred-milion-seek
```

然后在 agent 里选 `hundred-milion-seek/DeepSeek V4.1 Flash (free)`。

### 供应商 id

插件登录的供应商 id 是 **`hundred-milion-seek`**，不是 `100milionseek`。这样它可以
和你 `providers.json` 里手写的 `100milionseek` 并存，谁也不占谁的 id。agent 里写
`hundred-milion-seek/<模型>`。

想让插件接管已有的 id，就先改掉手写的那个，或者两个都加上之后用 `magpie plugin
use` 选。两个插件登录同一个 id 时只有一个在服务：选定的那个，否则是后加的那个。

## 登录

一个 API key，在 <https://100milionseek.top> 拿（以 `hms-` 开头）。保存前会用
`GET /v1/models` 验一次：

- 服务拒绝 → 登录失败，并显示服务自己给的原因；
- 服务连不上 → 照样保存，免得一次网络抖动把你锁在外面。

key 由 magpie 存在 `plugin-auth.json` 的 `hundred-milion-seek` 下。一个 key 就是一个
账号：再用第二个 key 登录会存成 `hundred-milion-seek#xxxxxx`，各自有各自的额度和
并发槽位。`magpie plugin logout hundred-milion-seek` 可以忘掉它。

## 模型

| 模型 | 是什么 |
| --- | --- |
| `deepseek-v4.1-flash-free` | 聊天模型。198K 上下文，64K 输出，流式，工具调用，OpenAI 兼容。 |
| `jev-1.13-free` | 判定模型。`POST /v1/systemone`，每个问题回一个概率；agent 看不到它，只给路由组用。 |

两者都吃同一份每日额度（判定模型按每个 token 0.2 计）。模型表是写死的而不是拉取
的，因为尺寸和判定模型的角色都不在 `GET /v1/models` 里；账号列表里出现了插件不认识
的模型时，会用聊天模型的形状描述它，而不是丢掉。

每个 key 同时 5 个请求，这是服务自己的上限——插件把它声明成 `maxConcurrency`，让
magpie 排队，而不是攒一堆 429。

## 不做什么

没有签到：这个服务没有每日领取的接口（注册是邮箱加 Cloudflare Turnstile），所以没
有 `checkin` 钩子。也没有需要刷新的登录态——API key 不会过期，401 意味着 key 被吊销
了，插件会报 `signIn: "expired"`。

## 目录

```
index.mjs          magpie 加载的入口
opencode.mjs       OpenCode 1.x 那一面
opencode2.mjs      OpenCode 2.x 那一面（与社区那份逐字节相同）
src/index.mjs      插件本体：config、auth、provider.models
src/models.mjs     模型表，小形状和大形状各一份
src/quota.mjs      x-quota-* 响应头 → 用量窗口
src/systemone.mjs  判定模型的回答 → magpie 读的形状
src/load.mjs       /api/status → 负载百分比
test/              测试，用 `npm test` 跑
```

## 开发

```sh
npm test          # 全部测试，不联网
npm run check     # 语法检查 + 测试
```

测试用假的 `fetch`，不碰真服务。想在不打扰自己 magpie 的情况下试真的：

```sh
sb=$(mktemp -d)
m() { env HOME=$sb XDG_CONFIG_HOME=$sb/.config XDG_CACHE_HOME=$sb/.cache \
      MAGPIE_ADDR=127.0.0.1:3499 magpie "$@"; }
m plugin add ./100milionseek
m plugin --json
m plugin login hundred-milion-seek
m provider test hundred-milion-seek
m quota
```

## 许可

MIT。
