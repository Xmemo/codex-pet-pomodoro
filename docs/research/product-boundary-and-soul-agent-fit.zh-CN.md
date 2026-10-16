# Pet Pomodoro / Character Reminder：产品边界与 Soul Agent 关系

> 状态：战略定位冻结  
> 更新时间：2026-10-16

## 1. 当前定位修正

Pet Pomodoro 不应继续沿着“宠物养成 + 番茄钟 + 更多习惯功能”膨胀。

此前讨论已经把核心从：

> 宠物 + Pomodoro

推进到：

> **Someone meaningful shows up when it matters.**

更准确的产品原语是：

```
Person / Pet
    ->
Character
    ->
Pose
    ->
Event
    ->
Surface
```

也就是：把现实中有情感意义的人、宠物，甚至未来的自己转成数字角色，并让其在重要时刻通过通知、Widget、Live Activity / Dynamic Island 等界面出现。

## 2. 它与 Kapi / Soul Agent 的关系

Character Reminder 更适合被理解为一个 **emotional delivery surface（情感化呈现层）**，而不是完整的行为决策系统。

统一模型：

```
Context
   ->
Decision
   ->
Intervention
   ->
Surface
```

其中：

- **Kapi / JITAI** 更擅长决定：什么时候介入、介入什么；
- **Character Reminder** 更擅长决定：这个介入以什么角色、姿态和情感形式出现；
- **未来 Relationship Agent** 还可以补充：信号来自谁、由谁表达。

因此架构上可以兼容，产品上暂时保持独立。

## 3. 当前产品边界

### 值得继续验证

- 照片 -> 稳定 Character identity；
- 同一角色的多姿态一致性；
- Pomodoro / 久坐 / 喝水 / 睡眠 / 自定义提醒；
- Notification / Widget / Live Activity 等系统呈现；
- 情感显著性是否提高提醒的注意与执行；
- 用户是否自然产生“我也想把某某做进去”的需求。

### 暂不进入

- 复杂养宠系统；
- 饥饿 / 体力 / 洗澡；
- 金币 / 钻石 / 商城；
- 大量 XP / 连续签到压力；
- 情侣日记、定位、聊天；
- 完整 Relationship Agent；
- 全功能 habit tracker；
- 通用 AI 陪聊。

原则：

> **角色是来照顾用户的，不是让用户每天再多照顾一个系统。**

## 4. 为什么不做“电子宠物 Super App”

电子宠物很容易走向：

```
cute -> obligation -> chore
```

一旦依赖喂食、货币、签到、广告才能维持角色状态，可爱本身会转化为负担。

因此本项目不以“宠物生存压力”制造留存。

优先追求：

- personal meaning；
- emotional salience；
- low-friction presence；
- shareable surprise。

## 5. MVP Gate

第一版不需要完整 App。

只需要验证这一条链：

```
Photo
  ->
Character
  ->
Set Focus
  ->
Timer ends
  ->
Character appears
```

测试三类输入：

1. 恋人 / 朋友；
2. 真实宠物；
3. 自己 / Future Me。

真正的成功反馈不是：

> “挺可爱的。”

而是：

> **“我也想把 XX 做进去。”**

前者只证明审美。

后者才证明 personalization demand。

## 6. 与 Relationship Agent 的未来连接

未来如果真实关系介入，可以从：

```
AI decides reminder
```

扩展为：

```
trusted person sends signal
    ->
agent decides timing / presentation
    ->
their character appears
```

例如：

- partner sends “早点睡”；
- 系统选择合适时机；
- 对方的 Character 以抱枕姿态出现。

但这属于未来的多人/关系层，不能成为当前 MVP 的启动条件。

## 7. 对 Soul Agent 的战略价值

Character / Pet 项目最有价值的长期贡献不是“养宠玩法”，而是回答：

> **行为介入是否因为承载了一个有情感意义的角色，而更容易获得注意、执行与记忆？**

如果成立，它可以成为 Soul Agent 的一种高价值 Surface。

因此当前定位：

> **Character Reminder = Soul Agent 的潜在情感化呈现层实验。**

不是 Soul Agent 本身。

## 8. 方法论

采用：

> **Platform in architecture, wedge in product.**

底层允许未来接 Kapi / JITAI / Relationship signal。

当前产品仍只验证 Character Reminder 这个楔子。

不要因为理论上能统一，就提前做统一产品。
