const difficultyOptions = [
  { value: "all", label: "全部难度" },
  { value: "基础", label: "基础" },
  { value: "进阶", label: "进阶" },
  { value: "博弈", label: "博弈" },
];

const screenLabels = {
  intro: "场景式表达训练",
  guide: "用法说明",
  setup: "选择沟通目的和难度",
  practice: "开始答题",
  feedback: "AI反馈",
};

const legacyStorageKeys = {
  drafts: "gaoming-training:drafts:v1",
  completed: "gaoming-training:completed:v1",
};

const storageKeys = {
  drafts: "gaoming-training:drafts:v2",
  attempts: "gaoming-training:attempts:v1",
  completed: "gaoming-training:completed:v2",
  feedbackHistory: "gaoming-training:feedback-history:v1",
};

const scenarioMap = new Map(scenarios.map((item) => [item.id, item]));

const state = {
  screen: "intro",
  setup: {
    category: "all",
    difficulty: "all",
  },
  drafts: loadObjectWithFallback(storageKeys.drafts, legacyStorageKeys.drafts),
  attempts: normalizeAttemptHistory(loadObject(storageKeys.attempts)),
  completed: loadSetWithFallback(storageKeys.completed, legacyStorageKeys.completed),
  feedbackHistory: loadObject(storageKeys.feedbackHistory),
  revealed: new Set(),
  inlineMessage: null,
  ai: {
    loadingConfig: true,
    serverReachable: false,
    configured: false,
    model: "deepseek-chat",
    baseUrl: "https://api.deepseek.com",
    scoring: false,
    error: "",
  },
  session: createEmptySession(),
  transitionLock: false,
};

const elements = {
  stage: document.querySelector("#stage"),
  aiStatusPill: document.querySelector("#ai-status-pill"),
  navButtons: [...document.querySelectorAll("[data-screen-target]")],
};

init();

async function init() {
  bindGlobalEvents();
  renderChrome();
  renderStage(false);
  await syncAiConfig();
}

function createEmptySession() {
  return {
    id: "",
    sceneIds: [],
    currentIndex: 0,
    startedAt: "",
    meta: null,
    feedback: null,
    feedbackUsage: null,
  };
}

function bindGlobalEvents() {
  elements.navButtons.forEach((button) => {
    button.addEventListener("click", () => {
      handleScreenJump(button.dataset.screenTarget);
    });
  });

  elements.stage.addEventListener("click", handleStageClick);
  elements.stage.addEventListener("input", handleStageInput);
  elements.stage.addEventListener("change", handleStageChange);
}

async function syncAiConfig() {
  state.ai.loadingConfig = true;
  renderChrome();

  try {
    const response = await fetch("/api/config", {
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      throw new Error(`配置接口返回 ${response.status}`);
    }

    const data = await response.json();
    state.ai.serverReachable = true;
    state.ai.configured = Boolean(data.configured);
    state.ai.model = data.model || "deepseek-chat";
    state.ai.baseUrl = data.base_url || "https://api.deepseek.com";
    state.ai.error = "";
  } catch (error) {
    state.ai.serverReachable = false;
    state.ai.configured = false;
    state.ai.error = "";
  } finally {
    state.ai.loadingConfig = false;
    renderChrome();

    if (state.screen === "setup" || state.screen === "feedback") {
      renderStage(false);
    }
  }
}

function handleScreenJump(target) {
  let nextScreen = target;

  if (nextScreen === "practice" && !getSessionScenes().length) {
    nextScreen = "setup";
  }

  goToScreen(nextScreen);
}

function handleStageClick(event) {
  const trigger = event.target.closest("[data-action]");

  if (!trigger) {
    return;
  }

  switch (trigger.dataset.action) {
    case "go-screen":
      handleScreenJump(trigger.dataset.target);
      break;
    case "start-session":
      startSession();
      break;
    case "go-prev-question":
      moveQuestion(-1);
      break;
    case "go-next-question":
      moveQuestion(1);
      break;
    case "save-answer":
      persistCurrentAttempt("manual");
      renderStage(false);
      break;
    case "toggle-answer":
      toggleAnswerPanel();
      break;
    case "score-session":
      startSessionScoring();
      break;
    case "restart-session":
      state.session = createEmptySession();
      state.revealed.clear();
      state.inlineMessage = null;
      goToScreen("setup");
      break;
    default:
      break;
  }
}

function handleStageInput(event) {
  if (!event.target.matches(".scene-draft")) {
    return;
  }

  const sceneId = event.target.dataset.sceneId;
  const value = event.target.value;

  if (value.trim()) {
    state.drafts[sceneId] = value;
  } else {
    delete state.drafts[sceneId];
  }

  saveObject(storageKeys.drafts, state.drafts);
  autoResizeTextarea(event.target);

  if (state.inlineMessage && state.inlineMessage.sceneId === sceneId) {
    state.inlineMessage = null;
    renderStage(false);
  }
}

function handleStageChange(event) {
  if (event.target.matches('[data-field="category"]')) {
    state.setup.category = event.target.value;
    state.inlineMessage = null;
    renderStage(false);
    return;
  }

  if (event.target.matches('[data-field="difficulty"]')) {
    state.setup.difficulty = event.target.value;
    state.inlineMessage = null;
    renderStage(false);
  }
}

function startSession() {
  const matchedScenes = getSetupScenes();

  if (!matchedScenes.length) {
    state.inlineMessage = {
      sceneId: "__setup__",
      type: "error",
      text: "当前筛选下没有匹配题目，请换一个沟通目的或难度。",
    };
    renderStage(false);
    return;
  }

  state.session = {
    id: createId(),
    sceneIds: matchedScenes.map((item) => item.id),
    currentIndex: 0,
    startedAt: new Date().toISOString(),
    meta: {
      category: state.setup.category,
      difficulty: state.setup.difficulty,
    },
    feedback: null,
    feedbackUsage: null,
  };
  state.revealed.clear();
  state.inlineMessage = null;
  goToScreen("practice");
}

function moveQuestion(direction) {
  const sessionScenes = getSessionScenes();

  if (!sessionScenes.length) {
    goToScreen("setup");
    return;
  }

  if (direction > 0) {
    persistCurrentAttempt("next", { requireText: false, announce: false });
  }

  const nextIndex = clamp(
    state.session.currentIndex + direction,
    0,
    sessionScenes.length - 1
  );

  if (nextIndex === state.session.currentIndex) {
    if (direction > 0 && nextIndex === sessionScenes.length - 1) {
      state.inlineMessage = {
        sceneId: sessionScenes[nextIndex].id,
        type: "ready",
        text: "已经是最后一题了。你可以回看上一题，或者直接进入 AI 总评。",
      };
      renderStage(false);
    }
    return;
  }

  state.session.currentIndex = nextIndex;
  state.inlineMessage = null;
  renderStage(true);
}

function toggleAnswerPanel() {
  const scene = getCurrentScene();

  if (!scene) {
    return;
  }

  if (!state.revealed.has(scene.id)) {
    const result = persistCurrentAttempt("reveal", {
      requireText: true,
      announce: false,
    });

    if (!result.ok) {
      renderStage(false);
      return;
    }

    state.revealed.add(scene.id);
    pulseFeedback();
    renderStage(false);
    return;
  }

  state.revealed.delete(scene.id);
  renderStage(false);
}

async function startSessionScoring() {
  persistCurrentAttempt("score", { requireText: false, announce: false });

  const answeredScenes = getAnsweredSessionPayload();
  state.inlineMessage = null;
  state.ai.error = "";
  state.session.feedback = null;
  state.session.feedbackUsage = null;
  state.ai.scoring = false;
  goToScreen("feedback");

  if (!answeredScenes.length) {
    state.ai.error = "这一轮还没有记录任何表达。至少先答一题，再让 AI 打分。";
    renderStage(false);
    return;
  }

  if (!state.ai.serverReachable) {
    state.ai.error =
      "当前没有连到本地评分服务。请用 `go run .` 启动本地服务后，再使用 DeepSeek 总评。";
    renderStage(false);
    return;
  }

  if (!state.ai.configured) {
    state.ai.error =
      "本地服务已启动，但还没有配置 `DEEPSEEK_API_KEY`，暂时不能调用 DeepSeek 打分。";
    renderStage(false);
    return;
  }

  state.ai.scoring = true;
  renderStage(false);

  try {
    const response = await requestSessionScore(answeredScenes);
    state.session.feedback = normalizeFeedback(response.feedback, answeredScenes.length);
    state.session.feedbackUsage = response.usage || null;
    state.feedbackHistory[state.session.id] = {
      createdAt: new Date().toISOString(),
      feedback: state.session.feedback,
      answeredCount: answeredScenes.length,
    };
    saveObject(storageKeys.feedbackHistory, state.feedbackHistory);
    pulseFeedback();
  } catch (error) {
    state.ai.error = error.message || "DeepSeek 评分失败，请稍后重试。";
  } finally {
    state.ai.scoring = false;
    renderStage(false);
  }
}

async function requestSessionScore(answeredScenes) {
  const sessionScenes = getSessionScenes();
  const response = await fetch("/api/score-session", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      session_id: state.session.id,
      session_meta: {
        category: getSelectedCategoryLabel(),
        difficulty: getSelectedDifficultyLabel(),
        total_questions: sessionScenes.length,
        answered_questions: answeredScenes.length,
      },
      answered_scenes: answeredScenes,
    }),
  });

  const payload = await safeParseJson(response);

  if (!response.ok) {
    throw new Error(payload.error || `评分接口返回 ${response.status}`);
  }

  return payload;
}

function getSetupScenes() {
  return scenarios.filter((item) => {
    if (state.setup.category !== "all" && item.category !== state.setup.category) {
      return false;
    }

    if (state.setup.difficulty !== "all" && item.difficulty !== state.setup.difficulty) {
      return false;
    }

    return true;
  });
}

function getSessionScenes() {
  return state.session.sceneIds.map((id) => scenarioMap.get(id)).filter(Boolean);
}

function getCurrentScene() {
  const sessionScenes = getSessionScenes();
  return sessionScenes[state.session.currentIndex] || null;
}

function getAttemptHistory(sceneId) {
  const history = state.attempts[sceneId];
  return Array.isArray(history) ? history : [];
}

function getLatestAttempt(sceneId) {
  const history = getAttemptHistory(sceneId);
  return history.length ? history[history.length - 1] : null;
}

function getAnsweredSessionPayload() {
  return getSessionScenes()
    .map((scene) => {
      const latest = getLatestAttempt(scene.id);

      if (!latest || !latest.text.trim()) {
        return null;
      }

      return {
        id: scene.id,
        title: scene.title,
        category: categoryMap.get(scene.category),
        difficulty: scene.difficulty,
        context: scene.context,
        goal: scene.goal,
        latest_answer: latest.text.trim(),
        attempt_count: getAttemptHistory(scene.id).length,
      };
    })
    .filter(Boolean);
}

function getAnsweredCountInSession() {
  return getAnsweredSessionPayload().length;
}

function getSelectedCategoryLabel() {
  return state.setup.category === "all"
    ? "全部沟通目的"
    : categoryMap.get(state.setup.category);
}

function getSelectedDifficultyLabel() {
  return state.setup.difficulty === "all" ? "全部难度" : state.setup.difficulty;
}

function persistCurrentAttempt(source, { requireText = true, announce = true } = {}) {
  const scene = getCurrentScene();

  if (!scene) {
    return { ok: false };
  }

  const rawText = state.drafts[scene.id] || "";
  const text = rawText.trim();

  if (!text) {
    if (requireText) {
      state.inlineMessage = {
        sceneId: scene.id,
        type: "error",
        text: "先把你的开口写下来，再看参考表达或进入下一步。",
      };
    }

    return { ok: !requireText };
  }

  const history = [...getAttemptHistory(scene.id)];
  const normalized = normalizeText(text);
  const lastEntry = history[history.length - 1];
  const alreadySaved = lastEntry && normalizeText(lastEntry.text) === normalized;

  if (!alreadySaved) {
    history.push({
      id: createId(),
      text,
      createdAt: new Date().toISOString(),
      source,
      sessionId: state.session.id || "",
    });
    state.attempts[scene.id] = history.slice(-20);
    saveObject(storageKeys.attempts, state.attempts);
  }

  state.completed.add(scene.id);
  saveSet(storageKeys.completed, state.completed);

  if (announce) {
    state.inlineMessage = {
      sceneId: scene.id,
      type: "ready",
      text: alreadySaved
        ? "当前这版表达已经记录过了，AI 评分会使用最近一次保存的版本。"
        : `已记录本题第 ${state.attempts[scene.id].length} 次表达。AI 总评会默认取最近一次版本。`,
    };
  }

  return { ok: true, alreadySaved };
}

function renderChrome() {
  renderAiStatusPill();

  elements.navButtons.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.screenTarget === state.screen);
  });
}

function renderAiStatusPill() {
  const pill = elements.aiStatusPill;
  pill.classList.remove("is-ready", "is-error", "is-pending");

  if (state.ai.loadingConfig) {
    pill.textContent = "正在检查 DeepSeek 评分状态";
    pill.classList.add("is-pending");
    return;
  }

  if (!state.ai.serverReachable) {
    pill.textContent = "未连接本地评分服务";
    pill.classList.add("is-error");
    return;
  }

  if (!state.ai.configured) {
    pill.textContent = "DeepSeek 服务已连通，API Key 未配置";
    pill.classList.add("is-pending");
    return;
  }

  pill.textContent = `DeepSeek 已连接 · ${state.ai.model}`;
  pill.classList.add("is-ready");
}

function goToScreen(screen) {
  state.screen = screen;
  renderChrome();
  renderStage(true);
}

function renderStage(withTransition) {
  if (withTransition) {
    transitionStage(() => renderStage(false));
    return;
  }

  elements.stage.innerHTML = getScreenMarkup();
  syncRenderedControls();
}

function transitionStage(callback) {
  const prefersReducedMotion =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (prefersReducedMotion || state.transitionLock) {
    callback();
    return;
  }

  state.transitionLock = true;
  elements.stage.classList.remove("is-entering", "is-entered");
  elements.stage.classList.add("is-leaving");

  window.setTimeout(() => {
    callback();
    window.scrollTo({ top: 0, behavior: "smooth" });
    elements.stage.classList.remove("is-leaving");
    elements.stage.classList.add("is-entering");

    requestAnimationFrame(() => {
      elements.stage.classList.add("is-entered");
    });

    window.setTimeout(() => {
      elements.stage.classList.remove("is-entering", "is-entered");
      state.transitionLock = false;
    }, 280);
  }, 180);
}

function syncRenderedControls() {
  const textarea = elements.stage.querySelector(".scene-draft");

  if (textarea) {
    autoResizeTextarea(textarea);
  }
}

function getScreenMarkup() {
  switch (state.screen) {
    case "guide":
      return renderGuideScreen();
    case "setup":
      return renderSetupScreen();
    case "practice":
      return renderPracticeScreen();
    case "feedback":
      return renderFeedbackScreen();
    case "intro":
    default:
      return renderIntroScreen();
  }
}

function renderIntroScreen() {
  return `
    <section class="screen screen-intro">
      <div class="screen-grid">
        <div class="surface-card">
          <p class="eyebrow">场景式表达训练</p>
          <h2>从“说不清楚”开始，练到“听得懂、愿意听、能推进”</h2>
          <p class="lead">
            这次不再把 200 道题一次性摊开。你会按单题流转去练，每次只面对一个场景，
            写完一句，再决定要不要看参考表达。
          </p>
          <div class="metric-row">
            <article class="metric-card">
              <span class="metric-value">${scenarios.length}</span>
              <span class="metric-label">总场景数</span>
            </article>
            <article class="metric-card">
              <span class="metric-value">${categories.length - 1}</span>
              <span class="metric-label">沟通目的</span>
            </article>
            <article class="metric-card">
              <span class="metric-value">单题</span>
              <span class="metric-label">逐题切换</span>
            </article>
          </div>
          <div class="button-row">
            <button type="button" class="primary-button" data-action="go-screen" data-target="guide">
              继续，先看用法说明
            </button>
            <button type="button" class="ghost-button" data-action="go-screen" data-target="setup">
              直接去选题
            </button>
          </div>
        </div>

        <aside class="surface-card">
          <p class="panel-label">这一版有什么变化</p>
          <ol class="bullet-list">
            <li>一屏只显示一个页面状态，不再长滚动找题。</li>
            <li>答题区一次只显示一题，并支持上一题、下一题。</li>
            <li>参考表达默认隐藏，必须先写再看。</li>
            <li>每次“你先说一句”都会被记录进本地历史。</li>
            <li>整轮答题结束后，可以交给 DeepSeek 做总评。</li>
          </ol>
        </aside>
      </div>
    </section>
  `;
}

function renderGuideScreen() {
  return `
    <section class="screen screen-guide">
      <div class="screen-head">
        <p class="eyebrow">用法说明</p>
        <h2>练的不是词藻，是顺序、边界和推进感</h2>
        <p class="lead">
          先把意思说到位，再把话说漂亮。你可以把每一题都当成一次真实开口，不求一句封神，但求句句有方向。
        </p>
      </div>

      <div class="triple-grid">
        <article class="principle-card">
          <p class="principle-index">01</p>
          <h3>先把目标说出来</h3>
          <p class="helper-note">你这句话要解决什么，先让对方知道，别把重点埋在铺垫里。</p>
        </article>
        <article class="principle-card">
          <p class="principle-index">02</p>
          <h3>再补关键事实</h3>
          <p class="helper-note">事实够支撑判断就行，不要把解释写成流水账。</p>
        </article>
        <article class="principle-card">
          <p class="principle-index">03</p>
          <h3>最后留出台阶</h3>
          <p class="helper-note">说清立场不等于说死关系，留余地才更像高手。</p>
        </article>
      </div>

      <div class="dual-grid">
        <article class="surface-card">
          <p class="panel-label">推荐练法</p>
          <ol class="bullet-list">
            <li>先按真实反应写一句，不要一开始就模仿答案。</li>
            <li>写完再看参考表达，重点看顺序，而不是照抄句子。</li>
            <li>同一题可以反复改写，系统会把每次表达都记下来。</li>
          </ol>
        </article>
        <article class="surface-card">
          <p class="panel-label">DeepSeek 总评怎么用</p>
          <ol class="bullet-list">
            <li>AI 总评默认只看你本轮已记录的题目。</li>
            <li>每题以最近一次保存的表达作为评分版本。</li>
            <li>评分结果会给出维度分数、薄弱点、激励话语和改写建议。</li>
          </ol>
        </article>
      </div>

      <div class="button-row">
        <button type="button" class="ghost-button" data-action="go-screen" data-target="intro">
          返回场景式表达训练
        </button>
        <button type="button" class="primary-button" data-action="go-screen" data-target="setup">
          继续，去选沟通目的和难度
        </button>
      </div>
    </section>
  `;
}

function renderSetupScreen() {
  const matchedScenes = getSetupScenes();
  const sampleScenes = matchedScenes.slice(0, 3);
  const setupMessage =
    state.inlineMessage && state.inlineMessage.sceneId === "__setup__"
      ? `<p class="inline-message">${escapeHtml(state.inlineMessage.text)}</p>`
      : "";
  const aiHint = getAiSetupHint();

  return `
    <section class="screen screen-setup">
      <div class="screen-head">
        <p class="eyebrow">选择沟通目的和难度</p>
        <h2>先定这轮练什么，再开始单题答题</h2>
        <p class="lead">
          你可以只练一种沟通局面，也可以把难度放开。页面会按当前组合生成一整轮题目，答题时一次只显示一题。
        </p>
      </div>

      <div class="screen-grid">
        <section class="setup-card">
          <label class="field">
            <span>沟通目的</span>
            <select data-field="category" aria-label="沟通目的">
              ${categories
                .map(
                  (item) => `
                    <option value="${item.id}" ${item.id === state.setup.category ? "selected" : ""}>
                      ${escapeHtml(item.label)}
                    </option>
                  `
                )
                .join("")}
            </select>
          </label>

          <label class="field">
            <span>难度</span>
            <select data-field="difficulty" aria-label="难度">
              ${difficultyOptions
                .map(
                  (item) => `
                    <option value="${item.value}" ${item.value === state.setup.difficulty ? "selected" : ""}>
                      ${escapeHtml(item.label)}
                    </option>
                  `
                )
                .join("")}
            </select>
          </label>

          <p class="setup-summary">
            当前组合：<strong>${escapeHtml(getSelectedCategoryLabel())}</strong> ·
            <strong>${escapeHtml(getSelectedDifficultyLabel())}</strong><br />
            本轮将包含 <strong>${matchedScenes.length}</strong> 道题。
          </p>

          ${setupMessage}

          <div class="button-row">
            <button type="button" class="ghost-button" data-action="go-screen" data-target="guide">
              返回用法说明
            </button>
            <button
              type="button"
              class="primary-button"
              data-action="start-session"
              ${matchedScenes.length ? "" : "disabled"}
            >
              继续，开始答题
            </button>
          </div>
        </section>

        <aside class="setup-card">
          <p class="panel-label">这一轮题目预览</p>
          <div class="sample-list">
            ${
              sampleScenes.length
                ? sampleScenes
                    .map(
                      (item) => `
                        <article class="sample-item">
                          <strong>${escapeHtml(item.title)}</strong>
                          <small>${escapeHtml(categoryMap.get(item.category))} · ${escapeHtml(item.difficulty)}</small>
                        </article>
                      `
                    )
                    .join("")
                : `<article class="sample-item">当前筛选下没有题目。</article>`
            }
          </div>

          <p class="panel-label">AI 评分状态</p>
          <p class="helper-note ${aiHint.className}">${escapeHtml(aiHint.text)}</p>
          <p class="storage-note">
            系统会自动记录你每次“你先说一句”的内容。DeepSeek 总评默认读取每题最近一次保存的版本。
          </p>
        </aside>
      </div>
    </section>
  `;
}

function renderPracticeScreen() {
  const sessionScenes = getSessionScenes();

  if (!sessionScenes.length) {
    return `
      <section class="screen">
        <article class="empty-card">
          <p class="panel-label">还没有开始答题</p>
          <h2>先去选一轮题目</h2>
          <p class="lead">你还没有生成本轮题目，所以这里暂时没有可切换的单题练习。</p>
          <div class="button-row">
            <button type="button" class="primary-button" data-action="go-screen" data-target="setup">
              去选择沟通目的和难度
            </button>
          </div>
        </article>
      </section>
    `;
  }

  const currentScene = getCurrentScene();
  const currentDraft = state.drafts[currentScene.id] || "";
  const currentHistory = getAttemptHistory(currentScene.id);
  const answeredCount = getAnsweredCountInSession();
  const progressPercent = Math.round(
    ((state.session.currentIndex + 1) / sessionScenes.length) * 100
  );
  const answerVisible = state.revealed.has(currentScene.id);
  const inlineMessage =
    state.inlineMessage && state.inlineMessage.sceneId === currentScene.id
      ? `<p class="inline-message">${escapeHtml(state.inlineMessage.text)}</p>`
      : "";

  return `
    <section class="screen screen-practice">
      <div class="screen-head">
        <p class="eyebrow">开始答题</p>
        <h2>第 ${state.session.currentIndex + 1} / ${sessionScenes.length} 题</h2>
        <div class="progress-stack">
          <div class="progress-meta">
            <span>已记录 ${answeredCount} 题</span>
            <span>${progressPercent}%</span>
          </div>
          <div class="progress-bar"><span style="width: ${progressPercent}%"></span></div>
        </div>
      </div>

      <article class="question-card">
        <div class="question-head">
          <div class="tag-row">
            <span class="tag is-category">${escapeHtml(categoryMap.get(currentScene.category))}</span>
            <span class="tag ${getDifficultyClass(currentScene.difficulty)}">${escapeHtml(
              currentScene.difficulty
            )}</span>
            <span class="tag">本轮：${escapeHtml(getSelectedCategoryLabel())} / ${escapeHtml(
              getSelectedDifficultyLabel()
            )}</span>
          </div>
          <h3>${escapeHtml(currentScene.title)}</h3>
        </div>

        <div class="prompt-grid">
          <dl class="prompt-card">
            <dt>场景背景</dt>
            <dd>${escapeHtml(currentScene.context)}</dd>
          </dl>
          <dl class="prompt-card">
            <dt>你的目标</dt>
            <dd>${escapeHtml(currentScene.goal)}</dd>
          </dl>
        </div>

        <label class="draft-area">
          <span>你先说一句</span>
          <textarea
            class="scene-draft"
            data-scene-id="${currentScene.id}"
            rows="5"
            maxlength="240"
            placeholder="先写下你会怎么开口。别急着漂亮，先把意思说准。"
          >${escapeHtml(currentDraft)}</textarea>
        </label>

        <p class="attempt-note">
          本题已记录 ${currentHistory.length} 次表达。DeepSeek 总评默认取最近一次保存的版本。
        </p>
        ${inlineMessage}

        <div class="question-actions">
          <button
            type="button"
            class="ghost-button"
            data-action="go-prev-question"
            ${state.session.currentIndex === 0 ? "disabled" : ""}
          >
            上一题
          </button>
          <button type="button" class="ghost-button" data-action="save-answer">
            记录本次表达
          </button>
          <button type="button" class="secondary-button" data-action="toggle-answer">
            ${answerVisible ? "收起参考表达" : "查看参考表达"}
          </button>
          <button
            type="button"
            class="primary-button"
            data-action="go-next-question"
            ${state.session.currentIndex === sessionScenes.length - 1 ? "disabled" : ""}
          >
            ${state.session.currentIndex === sessionScenes.length - 1 ? "已到最后一题" : "记录并下一题"}
          </button>
        </div>

        ${
          answerVisible
            ? `
              <section class="answer-panel">
                <div class="answer-block is-low">
                  <p class="answer-label">低分说法</p>
                  <p class="answer-text">${escapeHtml(currentScene.badExample)}</p>
                </div>
                <div class="answer-block is-high">
                  <p class="answer-label">推荐说法</p>
                  <p class="answer-text">${escapeHtml(currentScene.goodExample)}</p>
                </div>
                <div class="tips-block">
                  <p class="answer-label">拆解要点</p>
                  <ul class="tips-list">
                    ${currentScene.tips.map((tip) => `<li>${escapeHtml(tip)}</li>`).join("")}
                  </ul>
                </div>
              </section>
            `
            : ""
        }
      </article>

      <div class="return-row">
        <button type="button" class="text-button" data-action="go-screen" data-target="intro">
          返回场景式表达训练
        </button>
        <button type="button" class="text-button" data-action="go-screen" data-target="guide">
          返回用法说明
        </button>
        <button type="button" class="text-button" data-action="go-screen" data-target="setup">
          返回选择沟通目的和难度
        </button>
        <button type="button" class="primary-button" data-action="score-session">
          结束本轮并 AI 评分
        </button>
      </div>
    </section>
  `;
}

function renderFeedbackScreen() {
  const answeredCount = getAnsweredCountInSession();
  const feedback = state.session.feedback;

  if (state.ai.scoring) {
    return `
      <section class="screen">
        <article class="feedback-card loading-block">
          <p class="panel-label">AI 正在评分</p>
          <h2>DeepSeek 正在看你这轮的表达</h2>
          <p class="lead">
            系统会按“清晰度、抓重点、分寸感、说服力、层次感”几个维度做总评，并给出鼓励和改写方向。
          </p>
          <div class="loading-dots" aria-hidden="true">
            <span></span><span></span><span></span>
          </div>
        </article>
      </section>
    `;
  }

  if (!feedback) {
    return `
      <section class="screen">
        <article class="empty-card">
          <p class="panel-label">AI反馈</p>
          <h2>${answeredCount ? "还没生成这轮总评" : "先去答题，再回来拿总评"}</h2>
          <p class="lead">
            ${
              state.ai.error
                ? escapeHtml(state.ai.error)
                : answeredCount
                ? "你已经有可评分的答案了，现在可以点击按钮生成 DeepSeek 总评。"
                : "DeepSeek 总评会读取你本轮已经记录的题目和最近一次表达版本。"
            }
          </p>
          <div class="button-row">
            ${
              answeredCount
                ? `<button type="button" class="primary-button" data-action="score-session">开始 AI 总评</button>`
                : `<button type="button" class="primary-button" data-action="go-screen" data-target="setup">去选题并开始答题</button>`
            }
            <button type="button" class="ghost-button" data-action="go-screen" data-target="practice">
              返回答题
            </button>
          </div>
        </article>
      </section>
    `;
  }

  const scoreAngle = `${Math.round(feedback.overall_score * 3.6)}deg`;
  const dimensionLabels = [
    ["clarity", "清晰度"],
    ["focus", "抓重点"],
    ["tact", "分寸感"],
    ["persuasion", "说服力"],
    ["structure", "层次感"],
  ];

  return `
    <section class="screen screen-feedback">
      <div class="screen-head">
        <p class="eyebrow">AI反馈</p>
        <h2>这一轮表达总评已经出来了</h2>
        <p class="lead">
          本次总评基于本轮已记录的 ${answeredCount} 道题，读取每题最近一次保存的表达版本。
        </p>
      </div>

      <div class="dual-grid">
        <article class="feedback-card feedback-summary">
          <div class="score-hero">
            <div class="score-ring" style="--score-angle: ${scoreAngle}">
              <div>
                <strong>${feedback.overall_score}</strong>
                <span>综合得分</span>
              </div>
            </div>
            <div class="score-copy">
              <p class="panel-label">${escapeHtml(feedback.level)}</p>
              <h3>${escapeHtml(feedback.encouragement)}</h3>
              <p class="helper-note">${escapeHtml(feedback.summary)}</p>
            </div>
          </div>

          <div class="dimension-list">
            ${dimensionLabels
              .map(
                ([key, label]) => `
                  <div class="dimension-item">
                    <div class="dimension-head">
                      <span>${label}</span>
                      <strong>${feedback.dimension_scores[key]}</strong>
                    </div>
                    <div class="dimension-track">
                      <span style="width: ${feedback.dimension_scores[key]}%"></span>
                    </div>
                  </div>
                `
              )
              .join("")}
          </div>

          <div class="badge-row">
            ${feedback.badges.map((badge) => `<span class="result-badge">${escapeHtml(badge)}</span>`).join("")}
          </div>
        </article>

        <article class="feedback-card">
          <p class="panel-label">反馈重点</p>
          <h3>你现在最值得保住和继续加强的部分</h3>
          <ul class="feedback-list">
            ${feedback.strengths.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
          </ul>

          <p class="panel-label">接下来优先修的点</p>
          <ul class="feedback-list">
            ${feedback.improvement_points.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
          </ul>

          <p class="panel-label">下一轮练习建议</p>
          <ul class="feedback-list">
            ${feedback.next_actions.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
          </ul>

          ${
            state.session.feedbackUsage
              ? `<p class="helper-note">本次评分模型：${escapeHtml(state.ai.model)} · 输入 tokens ${state.session.feedbackUsage.prompt_tokens || 0}，输出 tokens ${state.session.feedbackUsage.completion_tokens || 0}</p>`
              : ""
          }
        </article>
      </div>

      <article class="feedback-card">
        <p class="panel-label">代表题目点评</p>
        <div class="scene-feedback-list">
          ${feedback.scene_feedback
            .map(
              (item) => `
                <article class="scene-feedback-item">
                  <div class="tag-row">
                    <span class="tag">${escapeHtml(item.title)}</span>
                    <span class="tag">${escapeHtml(String(item.score))} 分</span>
                    <span class="tag">${escapeHtml(item.verdict)}</span>
                  </div>
                  <p><strong>看得见的优点：</strong>${escapeHtml(item.what_worked)}</p>
                  <p><strong>最该修的一刀：</strong>${escapeHtml(item.what_to_improve)}</p>
                  <p><strong>更稳的开口参考：</strong>${escapeHtml(item.better_opening)}</p>
                </article>
              `
            )
            .join("")}
        </div>
      </article>

      <div class="button-row">
        <button type="button" class="ghost-button" data-action="go-screen" data-target="practice">
          返回答题继续练
        </button>
        <button type="button" class="ghost-button" data-action="go-screen" data-target="setup">
          重新选择题组
        </button>
        <button type="button" class="primary-button" data-action="restart-session">
          开始新一轮训练
        </button>
      </div>
    </section>
  `;
}

function getAiSetupHint() {
  if (state.ai.loadingConfig) {
    return { className: "", text: "正在检查评分服务状态。" };
  }

  if (!state.ai.serverReachable) {
    return {
      className: "is-error",
      text: "当前是纯静态页面模式。要启用 DeepSeek 评分，请运行 `go run .` 后再从本地地址打开页面。",
    };
  }

  if (!state.ai.configured) {
    return {
      className: "is-error",
      text: "评分服务已启动，但没有检测到 `DEEPSEEK_API_KEY`。配置环境变量并重启服务后即可使用总评。",
    };
  }

  return {
    className: "is-ready",
    text: `DeepSeek 已连接，当前模型：${state.ai.model}。`,
  };
}

function getDifficultyClass(difficulty) {
  if (difficulty === "基础") {
    return "is-difficulty-basic";
  }

  if (difficulty === "进阶") {
    return "is-difficulty-advanced";
  }

  return "is-difficulty-game";
}

function normalizeFeedback(rawFeedback, answeredCount) {
  const safeScore = clamp(Math.round(Number(rawFeedback?.overall_score) || 0), 0, 100);
  const dimensions = rawFeedback?.dimension_scores || {};

  return {
    overall_score: safeScore,
    level: rawFeedback?.level || getLevelByScore(safeScore),
    encouragement:
      rawFeedback?.encouragement ||
      `这轮你已经把 ${answeredCount} 道题认真练完了，表达的骨架正在慢慢立住。`,
    summary:
      rawFeedback?.summary ||
      "你已经开始能把自己的意思往前推了，下一步重点是把句子再收得更短、更稳、更有边界。",
    dimension_scores: {
      clarity: clamp(Math.round(Number(dimensions.clarity) || safeScore), 0, 100),
      focus: clamp(Math.round(Number(dimensions.focus) || safeScore), 0, 100),
      tact: clamp(Math.round(Number(dimensions.tact) || safeScore), 0, 100),
      persuasion: clamp(Math.round(Number(dimensions.persuasion) || safeScore), 0, 100),
      structure: clamp(Math.round(Number(dimensions.structure) || safeScore), 0, 100),
    },
    strengths: normalizeStringArray(rawFeedback?.strengths, [
      "你已经不只是“想到什么说什么”，开始有意识地先交代目标。",
      "很多句子已经能看出你在控制语气，而不是一味顶回去。",
      "你愿意把自己的表达写下来再比对，这本身就是进步最快的练法。",
    ]),
    improvement_points: normalizeStringArray(rawFeedback?.improvement_points, [
      "减少铺垫和自我解释，尽量更早亮出结论。",
      "多把边界说具体，而不是只说态度。",
      "结尾多留一个台阶，让话更容易推进下去。",
    ]),
    next_actions: normalizeStringArray(rawFeedback?.next_actions, [
      "下一轮优先练“先说目标，再补事实”的顺序。",
      "每题先把第一句压到更短，再看表达会不会更有力。",
      "挑两道你最绕的题，专门重写三版开口。",
    ]),
    badges: normalizeStringArray(rawFeedback?.badges, [
      "开始抓重点了",
      "会给对方留台阶了",
      "比之前更像在推进对话了",
    ]),
    scene_feedback: normalizeSceneFeedback(rawFeedback?.scene_feedback),
  };
}

function normalizeSceneFeedback(items) {
  if (!Array.isArray(items) || !items.length) {
    return [
      {
        title: "本轮代表题",
        score: 75,
        verdict: "逐渐稳住",
        what_worked: "你已经开始有意识地把话题拉回目标，而不是只凭情绪说。",
        what_to_improve: "下一步重点是把重点再说早一点，少一点铺垫。",
        better_opening: "我先把我的意思说明白，再往下展开。",
      },
    ];
  }

  return items.slice(0, 8).map((item) => ({
    title: item.title || "代表题目",
    score: clamp(Math.round(Number(item.score) || 0), 0, 100),
    verdict: item.verdict || "继续打磨",
    what_worked: item.what_worked || "你已经有了想把话说稳的意识。",
    what_to_improve: item.what_to_improve || "把第一句再收短一点，会更有力。",
    better_opening: item.better_opening || "我先把我的意思说明白，再往下展开。",
  }));
}

function normalizeStringArray(value, fallback) {
  if (Array.isArray(value) && value.length) {
    return value.map((item) => String(item).trim()).filter(Boolean).slice(0, 4);
  }

  return fallback;
}

function getLevelByScore(score) {
  if (score >= 88) {
    return "表达已经很稳";
  }

  if (score >= 76) {
    return "表达开始成型";
  }

  if (score >= 60) {
    return "表达正在立骨架";
  }

  return "表达还在找重心";
}

function normalizeAttemptHistory(value) {
  if (!value || typeof value !== "object") {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).map(([sceneId, items]) => [
      sceneId,
      Array.isArray(items)
        ? items
            .map((item) => ({
              id: item.id || createId(),
              text: String(item.text || "").trim(),
              createdAt: item.createdAt || new Date().toISOString(),
              source: item.source || "legacy",
              sessionId: item.sessionId || "",
            }))
            .filter((item) => item.text)
        : [],
    ])
  );
}

function loadSetWithFallback(primaryKey, legacyKey) {
  const primary = loadSet(primaryKey);
  return primary.size ? primary : loadSet(legacyKey);
}

function loadObjectWithFallback(primaryKey, legacyKey) {
  const primary = loadObject(primaryKey);
  return Object.keys(primary).length ? primary : loadObject(legacyKey);
}

function loadSet(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch (error) {
    return new Set();
  }
}

function saveSet(key, targetSet) {
  try {
    localStorage.setItem(key, JSON.stringify([...targetSet]));
  } catch (error) {
    // 本地存储失败时保持页面可用。
  }
}

function loadObject(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : {};
  } catch (error) {
    return {};
  }
}

function saveObject(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    // 本地存储失败时保持页面可用。
  }
}

async function safeParseJson(response) {
  try {
    return await response.json();
  } catch (error) {
    return {};
  }
}

function autoResizeTextarea(textarea) {
  textarea.style.height = "auto";
  textarea.style.height = `${Math.max(textarea.scrollHeight, 152)}px`;
}

function normalizeText(value) {
  return String(value).replace(/\s+/g, " ").trim();
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function createId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function pulseFeedback() {
  if (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    return;
  }

  if (typeof navigator.vibrate === "function") {
    navigator.vibrate(10);
  }
}
