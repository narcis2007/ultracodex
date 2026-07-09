[English](../README.md) · **한국어** · [日本語](./README.ja.md) · [简体中文](./README.zh-CN.md)

# ultracodex

> **Claude가 오케스트레이션하고, Codex가 교차 검증한다.**
> Codex 헤드리스(headless) 노드(`codex exec`)를 Claude Code 자체의 Workflow
> (*ultracode*) 오케스트레이션에 섞어 넣어, 동일 모델 간의 합의가 가장 신뢰하기
> 어려운 지점에서 진정으로 다른 계열의 모델이 검증하고, 판정하고, 재고하게
> 만든다.

`ultracodex`는 오픈소스 Claude Code 플러그인으로, 단 하나의 스킬
`codex-workflow`를 통해 [Codex](https://github.com/openai/codex) 헤드리스 노드를
**Workflow**에 섞는 법을 Claude에게 가르친다. 여기서 Workflow란 Claude Code의
`agent()` / `pipeline()` / `parallel()` 오케스트레이션 도구, 즉 *ultracode*를
말한다. 오케스트레이션 로직은 Claude의 JavaScript에 그대로 남고, 선택한 노드에서
바뀌는 것은 오직 *누가 그 일을 수행하느냐*뿐이다. 이것이 바로 **"Pattern A"**이며,
이는 모델을 교체하는 것이 아니라 더하는(additive) 방식이다. 두 계열의 모델이 하나의
Workflow 안에서 함께 실행된다.

```
Workflow (Claude JS orchestration)
 ├─ find / generate / synthesize .. Claude agent()  ← broad, fast, cache-warm
 └─ verify / judge / 2nd-opinion ... codex node     ← GPT, independent failure modes
```

> **GPT-5.6 지원 완료.** 설계상 모델 불가지론적이므로, GPT-5.6 세대
> (**Sol / Terra / Luna**, Codex CLI ≥ 0.144.0)는 출시 당일 아무 수정 없이
> ultracodex에서 동작했다. 문서에는 노드별 **티어·effort** 가이드가 추가되었다 —
> 넓은 verify 팬아웃에는 저가 티어를, 판정이 결정적인 노드에는 플래그십(최대
> `max`, Sol/Terra에서는 `ultra`까지)을 — 선택은 오케스트레이션하는 모델에
> 맡긴다.

> **ultracode 모드가 필요하다.** 이 스킬은 Workflow를 *작성하고 실행*하므로
> **Workflow** 오케스트레이션 도구가 반드시 사용 가능해야 한다. Claude Code에서
> 이는 곧 **ultracode 모드**를 의미한다(`/effort` → ultracode로 활성화하면 동적
> 워크플로 오케스트레이션이 켜진다). 이것이 없으면 플러그인은 여전히 로드되고
> 스킬도 인식되지만, 구동할 Workflow 도구가 존재하지 않는다.
> [사전 요구 사항](#prerequisites)을 참고하라.

## 왜 존재하는가 — 철학

*같은* 모델에서 검증자를 더 늘리면 그 모델의 맹점을 공유하는 경향이 있다. 같은
**상관된 거짓 양성(correlated false positives)**을 서로 재확인할 뿐이다. 다른 계열의
모델은 다른 입력에서 실패하므로, 동일 모델 리뷰어들이 무비판적으로 통과시킬 내용을
반박할 수 있다. 핵심 아이디어는 바로 이것이다.

- **교체가 아니라 다양성.** 이득은 *독립적인 모델 간의 불일치*에서 나오므로, 목표는
  두 계열을 한 번의 실행 안에 함께 유지하는 것이지 Claude를 빼버리는 것이 결코
  아니다. "두 번째 의견을 추가하라"는 옳지만 "대신 GPT를 써라"는 요점을 놓친다.
- **독립적인 실패 양상은 같은 모델을 더 늘리는 것보다 낫다.** verify/judge 노드를
  Codex로 라우팅하면 *상관된* 오류를 줄인다. 이는 Claude 검증자를 N개 더 추가해도
  같은 지점에서 실패하기 때문에 잡아낼 수 없는 종류의 오류다.
- **오케스트레이션은 Claude에 머문다.** Claude가 컨텍스트, 스키마, 팬아웃(fan-out),
  종합을 모두 쥐고 있다. codex 노드는 그저 평범한 `agent()`일 뿐이며, 그 서브에이전트가
  `codex exec` 실행을 중계할 뿐이다. Workflow 프리미티브는 전혀 바뀌지 않으므로,
  변경 면적을 작게 유지하면서 cross-model 가치를 얻을 수 있다.
- **두 번째 모델은 진실의 근원(source of truth)이 아니다.** 그것은 *또 다른 실패
  양상의 분포*일 뿐이며, 테스트, 증거, 엄격한 스키마, 그리고 최종 Claude 종합과 함께
  결합할 때 가장 효과적이다. "독립적"이라는 것도 상대적이다. 공유된 프롬프트, 공유된
  증거, 느슨한 스키마는 여전히 오류를 상관시킬 수 있으므로, 검증할 수 있는 산출물이
  존재하는 곳에서 Codex를 의도적으로 사용하라.

## 얻을 수 있는 것

- **동일 모델 리뷰를 살아남는 거짓 양성을 잡아낸다** — 다른 계열의 모델은 어떤 발견이나
  주장에 따라 행동하기 전에 *일부* 상관된 Claude 오류를 반박할 *수 있다*(이는 상관
  오류의 감소이지 보장은 아니다).
- **위험한 결론에 대해 더 높은 신뢰의 판정** — 보고하거나 출시하기 전에, 그 결과를
  만들어내지 않은 모델로 핵심 결과를 교차 검증한다.
- **진정으로 다양한 심사 패널** — 어떤 모델도 자기 작업만을 심사하지 않는 배심으로
  후보를 채점하여, LLM-as-judge 구성에서의 자기선호 편향을 줄인다.
- **생성 과정에서의 실질적 해법 다양성** — N-way 패널에서의 Codex 시도는 다른 계열의
  답이지, 표현만 바꾼 Claude의 답이 아니다.
- **새로운 장치 없이 가능한 대용량 컨텍스트, 다중 파일 검증** — Codex의 작업 대상을
  트리로 지정하면(`cwd` / `-C`; read-only는 쓰기를 막을 뿐 읽기는 막지 않는다) 큰
  diff와 파일을 Codex가 직접 읽으므로, 프롬프트에 일일이 붙여 넣을 필요가 없다.
- **노드별 티어·effort 라우팅** — 모든 codex 노드는 `model` / `effort`를 열린
  선택지로 받는다: 넓은 verify 팬아웃에는 `gpt-5.6-luna` + `low`, 판정 하나가
  결정적일 때는 `gpt-5.6-sol` + `xhigh`/`max`(또는 `ultra`). 아무것도 하드코딩하지
  않으며, 오케스트레이션하는 모델이 노드마다 고른다.
- **복사-붙여넣기 즉시 사용 가능** — 완성된 네 가지 Workflow 템플릿(cross-model 리뷰,
  혼합 심사 패널, 단일 결론 교차 검증, loop-until-dry)과 표준 `codexNode` 헬퍼를
  제공한다. 빈 파일이 아니라 동작하는 스크립트에서 시작한다.
- **최소한의 표면 변경** — 모든 Workflow 프리미티브를 있는 그대로 유지하며, 선택한
  노드의 담당자만 바뀐다.

## ROI가 가장 높은 사용처: 적대적 검증

Claude는 폭넓게 찾고, Codex는 각 발견을 **반박**하려 한다(확신이 서지 않으면
"반박됨(refuted)"을 기본값으로 둔다). 살아남은 것들이 바로 다른 계열의 모델이
무너뜨리지 못한 발견이다. 별도의 장벽 없이 파이프라인 하나로 처리한다.

```js
const results = await pipeline(
  DIMENSIONS,
  d => agent(d.findPrompt, { phase: 'Find', schema: FINDINGS }),         // Claude finds
  review => parallel((review?.findings ?? []).map(f => () =>
    codexNode(`Adversarially verify, defaulting to refuted=true if uncertain:\n${f.title}\n${f.detail}`,
      { schema: VERDICT, phase: 'Verify', label: `codex:${f.id}` })       // Codex refutes
      .then(v => ({ ...f, verdict: v })))),
)
const confirmed = results.flat().filter(Boolean)
  .filter(f => f.verdict && !f.verdict._codex_error && f.verdict.refuted === false)
```

혼합 **심사 패널**과 단일 결론 **두 번째 의견**은 그다음 단계다. 전체 스크립트는
[`workflow-templates.md`](./plugins/ultracodex/skills/codex-workflow/references/workflow-templates.md)에
있다.

## 언제 사용하고 언제 피해야 하는가

cross-model은 신호이지, 공짜 신호는 아니다. *두 번째 독립 모델*이 결과의 위험을
실질적으로 낮출 때 codex 노드를 꺼내라. 발견을 검증하거나, 후보를 심사하거나, 패널에서
독립적인 시도를 하거나, 위험한 결론을 점검할 때다.

**다음 경우에는 블렌딩을 건너뛰어라.**

- 대량 처리량 작업일 때(Claude 서브에이전트가 더 싸고, 더 빠르며, cache-warm 상태다);
- **상관된 검사(correlated check)**일 때 — Codex가 같은 증거에서 같은 결론을 재도출할
  뿐이라면, 이는 두 번째 의견이 아니라 메아리다;
- **블라인드 검사(blind check)**일 때 — 노드가 Codex에게 독립적으로 검증하는 데 필요한
  정보를 제공할 수 없을 때;
- 검증/심사 가능한 산출물이 없을 때(열린 형태의 발상) — 다양성은 신호가 아니라 잡음을
  더한다.

## 사전 요구 사항

- **Ultracode 모드 — Workflow 도구.** 이 스킬은 Workflow를 *작성하고 실행*하므로
  **Workflow** 도구(`agent()`/`pipeline()`/`parallel()`)가 반드시 사용 가능해야 한다.
  Claude Code에서 이는 **ultracode 모드**를 의미한다. `/effort` → ultracode로
  활성화하라(xhigh + 동적 워크플로 오케스트레이션). 이 스킬은 Workflow를 *작성하는*
  노하우만 제공할 뿐, 도구 자체를 추가하지는 **않으므로**, ultracode 모드가 없으면
  구동할 대상이 없다.
- **설치 및 인증된 Codex CLI.** 먼저 확인한 뒤 로그인하라(대화형이며, 헤드리스로는
  수행할 수 없다):
  ```bash
  command -v codex && codex --version
  codex login
  ```
- **POSIX 셸**(`bash`/`zsh`) — 중계 노드용.

> 이 스킬은 Codex 버전이나 기본 모델을 **하드코딩하지 않는다** — 환경이 제각각이기
> 때문이다. 어떤 노드든 신뢰하기 전에 한 번 실행할 수 있도록, 가벼운 **프리플라이트**
> (CLI 존재 여부, 인증 활성 여부, 구조화 출력 경로)를 함께 제공한다.

## 설치

`ultracodex`는 그 자체로 단일 플러그인 마켓플레이스다. 추가하고, 플러그인을 설치한
뒤, 다시 로드하라:

```text
/plugin marketplace add KingGyuSuh/ultracodex
/plugin install ultracodex@ultracodex
/reload-plugins
```

비대화형(CLI) 동등 방식:

```bash
claude plugin marketplace add KingGyuSuh/ultracodex
claude plugin install ultracodex@ultracodex
# then restart Claude Code, or run /reload-plugins in an existing session
```

> 설치 시 붙는 `@ultracodex` 접미사는 마켓플레이스 **이름**(최상위 `name`이 `.claude-plugin/marketplace.json`에
> 정의되어 있음)이며, 저장소 이름과는 무관하다 — 여기서는 우연히 일치할 뿐이다.

### 설치하지 않고 써보기

```bash
claude --plugin-dir ./plugins/ultracodex
```

## 사용법

두 번째 모델을 루프에 넣어 어떤 작업을 커스텀 Workflow로 실행해 달라고 Claude에게
요청하면 스킬이 자동으로 트리거된다. 이를 활성화하는 표현에는 다음이 포함된다.

- "Run this as a custom workflow that mixes in codex."
- "Have codex adversarially verify the findings."
- "Use codex as a juror / second opinion in the workflow."
- "Cross-model verify this while you orchestrate."

그러면 Claude는 verify/judge 노드가 `codex exec`로 셸 호출을 하고 find/generate/synthesize는
Claude에 머무는 Workflow를 — 템플릿에서 시작하여 — 작성한다.

## 작동 방식 — codex 노드

Workflow 스크립트의 JS 본문에는 **파일시스템 접근 권한이 없다**. 그래서 codex 노드는
자신의 JSON Schema를 문자열로 임베드하고, Bash를 다룰 수 있는 래퍼(wrapper)
서브에이전트가 그것을 임시 파일에 쓰도록 한다. 하나의 `schema` 객체가 유일한 진실의
근원이다. 이는 Codex의 `--output-schema`에 공급되고, `revalidate`가 true일 때는
`agent()`의 재검증에도 쓰인다. 기본값인 `revalidate: true`에서 노드는 파싱된 객체를
반환한다. `revalidate: false`에서는 호출자가 `JSON.parse`할 수 있도록 원시 JSON
텍스트를 중계한다. 계약(contract)은 다음과 같다.

```
codexNode(taskText, { schema, sandbox='read-only', model, cwd, effort, revalidate=true, phase, label })
  → Promise<parsedObject>   // revalidate:true (default)
  → Promise<string>         // revalidate:false — you JSON.parse it
  → { _codex_error: true }  // on failure
```

핵심을 떠받치는 세 가지 규칙이 있다.

1. **해결자가 아니라 중계자.** 래퍼 역할의 Claude 서브에이전트는 똑똑하기 때문에 그냥
   질문에 직접 답하려는 유혹을 받는다 — 그러면 cross-model 노드가 슬그머니 Claude
   노드로 다시 붕괴된다. 프롬프트는 이를 금지하므로, 그 지시를 끝까지 강하게 유지하라.
2. **stdout이 아니라 `-o` 파일에서 추출하라.** stdout에는 세션 부가 정보가 섞여 있다.
   `-o`가 깨끗한 JSON을 얻는 유일한 경로다.
3. **프롬프트는 stdin으로 전달하라**(`- < "$TASK"`) — 그래야 따옴표, `$`, 백틱이
   깨지거나 확장되지 않는다.

복사-붙여넣기용 전체 헬퍼는
[`workflow-templates.md`](./plugins/ultracodex/skills/codex-workflow/references/workflow-templates.md)에
표준으로 들어 있고, 동작 원리, 플래그, sandbox 단계, 문제 해결, 에스컬레이션 패턴은
[`codex-headless.md`](./plugins/ultracodex/skills/codex-workflow/references/codex-headless.md)에
있다.

### 라우팅: Codex 노드와 Claude 노드

| 노드의 역할 | 실행 위치 | 이유 |
| --- | --- | --- |
| 폭넓게 찾기 / 생성 / 탐색 | **Claude** | 빠르고, cache-warm 상태이며, 저렴한 팬아웃 |
| 발견을 적대적으로 검증 | **Codex** | 다른 실패 양상이 상관된 거짓 양성을 줄일 수 있음 |
| 후보 심사 / 채점 | **Codex** (또는 혼합 패널) | 후보를 작성하지 않은 배심원 |
| 다양한 패널에서의 한 시도 | **혼합** | 표현만 바꾼 Claude가 아닌 진정한 해법 다양성 |
| 종합 / 결정 / 정리 | **Claude** | 오케스트레이션 컨텍스트를 쥐고 있음 |

## 비용, 동시성, 에스컬레이션

- **두 가지 과금 지점.** 모든 codex 노드는 Anthropic 래퍼 턴 *과 더불어* Codex/OpenAI
  실행 비용을 함께 지불한다. 래퍼는 중계만 하지만 그래도 서브에이전트의 고정 오버헤드를
  갖는다 — 수백 개를 무심코 팬아웃하지 말고, 대신 작은 항목들을 **배치(batch)**하라.
- **codex 노드를 짧게 유지하라.** 각 노드는 Codex의 전체 실행 시간 동안 Workflow
  동시성 슬롯(`min(16, cores−2)`) 하나를 점유하며, 그 사이 래퍼는 블로킹 Bash
  호출에서 유휴 상태로 대기한다. read-only 검증/심사/소규모 생성에만 쓰라.
- **긴 작업은 에스컬레이션하라.** 수 분에서 수 시간이 걸리거나, 병렬이거나, 재개
  가능한 Codex 작업은 Pattern A가 **아니다** — 백그라운드 워커 풀이나 단발성
  핸드오프(스킬에 설명되어 있음)를 쓰고, Workflow 내부에 긴 노드를 두지 말라.

## 포함된 내용

단 하나의 스킬, `codex-workflow`:

- **`SKILL.md`** — 사고 모델, `codexNode` 계약, 핵심을 떠받치는 규칙, 라우팅,
  비용/동시성, 그리고 프리플라이트.
- **`references/codex-headless.md`** — `codex exec` 플래그, sandbox 단계, 출력
  추출, 함정, 문제 해결, `_codex_error` 규율, 에스컬레이션 패턴.
- **`references/workflow-templates.md`** — 표준 `codexNode` 헬퍼와 완성된 네 가지
  Workflow 스크립트, 그리고 배치 노드 및 대용량 페이로드 변형.

```
ultracodex/                              # repo root = marketplace root
├── .claude-plugin/
│   └── marketplace.json                 # single-plugin marketplace catalog
├── plugins/
│   └── ultracodex/                      # the plugin
│       ├── .claude-plugin/
│       │   └── plugin.json              # plugin manifest
│       ├── README.md
│       └── skills/
│           └── codex-workflow/
│               ├── SKILL.md
│               └── references/
│                   ├── codex-headless.md
│                   └── workflow-templates.md
├── docs/                                # README translations (ko / ja / zh-CN)
├── LICENSE                              # Apache-2.0
├── NOTICE
└── README.md
```

범위는 의도적으로 **스킬 전용**이다: 명령어, 에이전트, 훅, MCP 서버는 없다.

## 개발

```bash
claude plugin validate ./plugins/ultracodex   # plugin manifest + skill frontmatter
claude plugin validate .                       # marketplace manifest
claude plugin tag ./plugins/ultracodex         # cut a release tag (manifests must agree)
```

## 감사의 말

`codex-workflow` 스킬은 같은 이름의 비공개 in-repo 스킬을 오픈소스로 일반화한
것이다. 이번 릴리스는 환경별 사실(대신 프리플라이트로 처리한다)과 비공개 경로 참조를
제거했으며, 그 자체가 이 플러그인의 블렌딩된 Claude+Codex 워크플로로 개발되고 교차
검증되었다 — 이 README도 그렇게 cross-model로 초안을 작성하고 교정했다.

## 라이선스

[Apache-2.0](./LICENSE) © 2026 KingGyuSuh
