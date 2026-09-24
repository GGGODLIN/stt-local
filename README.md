# stt-local

本機常駐的語音轉文字服務。手機（經過 Collie）和電腦（經過 VoiceInk）都呼叫它，轉錄只有這一套：要換引擎、改轉繁體或加潤稿，只改這裡。

```
電腦：VoiceInk ──────────────┐
                             ├→ stt-local（127.0.0.1:8732）→ codex 登入 token → chatgpt.com 轉錄 → 台灣繁體
手機 → Collie（stt.json）─────┘
```

- **對外格式**：OpenAI 的 `POST /v1/audio/transcriptions`（multipart，音檔放 `file`），回 `{"text": "..."}`。`model`、`language`、`prompt` 欄位收下但不理會。
- **只聽 127.0.0.1**，而且每個請求都要帶 `Authorization: Bearer <apiKey>`：電腦上任何程式都能連本機，沒 key 等於誰都能用你的 GPT 訂閱。
- **不存錄音也不記文字**：log 每個請求一行，只有狀態碼、大小與耗時。
- **健康檢查**：`GET /health`。啟動後第一次會回「還沒檢查」，幾秒後再問就是實際狀態。

## 安裝

1. 建立設定檔（會產生新的 key，權限 0600，已存在就拒絕覆寫）：

   ```sh
   bun install
   bun src/init.ts /absolute/path/to/codex
   ```

2. 安裝 launchd，開機自動啟動、掛了 10 秒內重啟：

   ```sh
   cp launchd/com.gggodlin.stt-local.plist ~/Library/LaunchAgents/
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.gggodlin.stt-local.plist
   ```

設定檔在 `~/.config/stt-local/config.json`（`STT_LOCAL_CONFIG` 可改路徑）：

| 欄位 | 說明 |
|---|---|
| `port` | 預設 8732 |
| `apiKey` | 呼叫端必帶的 bearer key，至少 16 字元 |
| `codexBin` | codex 執行檔的絕對路徑；launchd 的 PATH 找不到 nvm 裝的 codex |
| `wireIdentity` | `honest`（預設，User-Agent 報 `stt-local/<版本>`）或 `codex-cli` |
| `convert` | `zh-TW` 轉台灣繁體；不寫就原樣回傳 |

改設定檔後要重啟：`launchctl kickstart -k gui/$(id -u)/com.gggodlin.stt-local`。

## 接上呼叫端

**Collie**：`~/.local/state/collie/stt.json` 寫成下面這樣，不用重啟 Collie（它依修改時間重讀）。驗證用 `collie stt test`。

```json
{
  "provider": "openai-compatible",
  "baseUrl": "http://127.0.0.1:8732/v1",
  "apiKey": "<config.json 裡的 apiKey>"
}
```

**VoiceInk**：在 AI Models 新增自訂的雲端轉錄模型，endpoint 填 `http://127.0.0.1:8732/v1/audio/transcriptions`，API key 填同一把，model 名稱隨意。AI Enhancement（潤稿）要關掉，否則電腦會比手機多潤稿一次。

## 以後換成本機模型

把這個服務的後端換成本機引擎（例如 whisper.cpp 的 `server`），手機和電腦會一起換；或直接讓 Collie 與 VoiceInk 都指向那個引擎，一樣只改一個地方。

## vendored 程式

`src/vendor/` 抄自 [Collie](https://github.com/GGGODLIN/collie) 的 `bridge/stt/`（fork commit `aa8b9f5f`），MIT 授權，見 [src/vendor/LICENSE-collie](/src/vendor/LICENSE-collie)。改動：import 改指向 `types.ts`、誠實身分的 User-Agent 改報 `stt-local`、兩句提示字串不再提 `collie stt test`。要跟上游時，拿 Collie 的同名檔案做 diff。
