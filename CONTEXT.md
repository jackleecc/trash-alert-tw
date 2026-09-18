# Trash Alert TW (台灣垃圾車即時推播系統)

台灣跨縣市垃圾車即時動態追蹤與 LINE 到站推播預警系統。

## Language

### Core Domain

**Stop**:
清運點（站點），垃圾車表定停靠收運的地理座標與時間標記。
_Avoid_: Station, Spot, Point

**Route**:
清運路線，特定行政區與日期的車輛收運路徑代碼與班表集合。
_Avoid_: Line, Path

**Subscription**:
LINE 群組關注特定清運點的訂閱關聯，決定推播收件對象。
_Avoid_: Binding, Follow

**Truck Arrival**:
即時車輛動態通過自適應圍欄、行車方向與表定時間窗檢驗的到站事件。
_Avoid_: Reach, Match

**Notification Intent**:
包含收件群組、路線、站點與推播文案之發送意圖物件。
_Avoid_: Payload, PushRequest

**Quota Melt**:
當月 LINE 推播總量達 200 則上限門檻時，全域阻斷一般通知之熔斷保護狀態。
_Avoid_: Throttle, CircuitBreak

**Cooldown Claim**:
發送通知前以 (群組, 路線, 站點) 為鍵原子佔用之 30 分鐘防重複推播鎖。
_Avoid_: Mutex, Lock, Dedup

**Subscription Context**:
今日啟用的路線、站點、群組訂閱、縮時窗狀態與深度休眠標記之集合。
_Avoid_: SubState, ContextData

**Arrival Matcher**:
依據自適應圍欄半徑、行車速度、進場方位角與歷史信任車牌，判定即時車輛到站之純運算引擎。
_Avoid_: MatchEngine, GeoChecker

### Intake & Operations

**Truck Intake**:
外部縣市環保局即時車輛動態資料之擷取、錯誤重試與正規化管線。
_Avoid_: Scraper, Fetcher

**City Intake Adapter**:
針對特定縣市專屬連線協定（REST JSON、ASMX POST、Session Cookie）之內部傳輸適配器。
_Avoid_: Driver, Client

**City Pause Status**:
特定縣市外部 API 連續連線失敗達到門檻時，當日隔離略過該縣市檢核之暫停狀態。
_Avoid_: Blacklist, Ban

**Truck Tracking Cycle**:
涵蓋訂閱解析、外部車輛擷取、到站比對、天候感知與推播調度之完整端到端清運排程週期。
_Avoid_: CheckTrucksLoop, MainJob

**Endpoint Guard**:
HTTP 進入點之密鑰時序防護比對、觸發來源提取與統一未授權阻斷攔截器。
_Avoid_: AuthMiddleware, SecurityFilter

**Execution Audit Log**:
包含執行狀態、觸發來源、車輛與通知計數之全系統排程稽核記錄。
_Avoid_: AccessLog, TraceLog


