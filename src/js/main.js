import { getCurrentUser } from "./api.js";
import {
  createAppContext,
  showAuth,
  showApp,
  switchView,
  applyRoleAccess,
  refreshSimulatorIfEnabled,
} from "./app-context.js";
import { bindAuthEvents } from "./auth-ui.js";
import { bootstrapCoreApp, renderRoleState } from "./frontend-bootstrap.js";

const ROLE_FEATURES = {
  student: {
    studentFlow: () => import("./student-flow.js"),
    studentClassManagement: () => import("./student-class-management.js"),
    studentComplaints: () => import("./student-complaints.js"),
    studentComplaintActions: () => import("./student-complaint-actions.js"),
    resultModal: () => import("./result-modal.js"),
  },
  teacher: {
    complaints: () => import("./complaints.js"),
    assessmentWizard: () => import("./assessment-wizard.js"),
    assessmentUx: () => import("./assessment-ux.js"),
    classManagement: () => import("./class-management.js"),
    monitoring: () => import("./monitoring.js"),
    demoData: () => import("./demo-data.js"),
    dashboard: () => import("./dashboard.js"),
    questionBank: () => import("./question-bank.js"),
    notifications: () => import("./notifications.js"),
    simulator: () => import("./simulator.js"),
    resultModal: () => import("./result-modal.js"),
  },
  admin: {
    userManagement: () => import("./user-management.js"),
    monitoring: () => import("./monitoring.js"),
    apiKeys: () => import("./api-keys.js"),
    research: () => import("./research.js"),
    researchLab: () => import("./research-lab.js"),
    observability: () => import("./observability.js"),
    questionBank: () => import("./question-bank.js"),
    notifications: () => import("./notifications.js"),
    simulator: () => import("./simulator.js"),
    resultModal: () => import("./result-modal.js"),
  },
};

async function loadAuthenticatedFeatures(role) {
  const factories = ROLE_FEATURES[role] || {};
  const loaded = await Promise.all(
    Object.entries(factories).map(async ([name, load]) => [name, await load()])
  );
  return Object.fromEntries(loaded);
}

function bindTeacherFeatures(ctx, modules) {
  modules.assessmentWizard?.bindAssessmentWizardEvents(ctx);
  modules.assessmentUx?.enhanceAssessmentWizardUX(ctx);
  modules.classManagement?.bindClassManagementEvents(ctx);
  modules.monitoring?.bindMonitoringEvents(ctx);
  modules.demoData?.bindDemoDataEvents(ctx);
  modules.dashboard?.bindDashboardEvents(ctx);
  modules.questionBank?.bindQuestionBankEvents(ctx);
  modules.notifications?.startNotificationListener(ctx);
  modules.simulator?.bindSimulatorEvents(ctx);
}

function bindAdminFeatures(ctx, modules) {
  modules.userManagement?.bindUserManagementEvents(ctx);
  modules.monitoring?.bindMonitoringEvents(ctx);
  modules.apiKeys?.bindApiKeyEvents(ctx);
  modules.research?.bindResearchEvents(ctx);
  modules.researchLab?.bindResearchLabEvents(ctx);
  modules.observability?.bindObservabilityEvents(ctx);
  modules.questionBank?.bindQuestionBankEvents(ctx);
  modules.notifications?.startNotificationListener(ctx);
  modules.simulator?.bindSimulatorEvents(ctx);
}

function bindStudentFeatures(ctx, modules) {
  modules.studentFlow?.bindStudentFlowEvents(ctx);
  modules.studentClassManagement?.bindStudentClassManagementEvents(ctx);
  modules.studentComplaintActions?.bindStudentComplaintActions(ctx);
}

function bindAuthenticatedFeatures(ctx, modules) {
  const role = ctx.auth.user.role;
  if (role === "teacher") {
    modules.complaints?.bindComplaintEvents(ctx);
  }
  modules.resultModal?.bindResultModalEvents(ctx);

  if (role === "teacher") bindTeacherFeatures(ctx, modules);
  else if (role === "admin") bindAdminFeatures(ctx, modules);
  else if (role === "student") bindStudentFeatures(ctx, modules);
}

function bindGlobalNavigation(ctx) {
  ctx.els.mainNav.addEventListener("click", (event) => {
    const button = event.target.closest(".nav-button");
    if (button) void switchView(ctx, button.dataset.view);
  });

  window.addEventListener("popstate", () => {
    if (!ctx.auth?.authenticated) return;
    const viewId = history.state?.lisanView;
    if (viewId) void switchView(ctx, viewId, { fromHistory: true });
  });

  document.addEventListener("click", async (event) => {
    const filterButton = event.target.closest("[data-student-filter]");
    if (!filterButton) return;

    document.querySelectorAll("[data-student-filter]").forEach((button) => {
      button.classList.toggle("active", button === filterButton);
    });

    const { renderStudentArea } = await import("./render.js");
    renderStudentArea(ctx.els, ctx.state, ctx.session);
  });

  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-nav-view]");
    if (button) void switchView(ctx, button.dataset.navView);
  });

  document.addEventListener("click", (event) => {
    if (event.target.closest(".more-menu")) return;

    document.querySelectorAll(".more-menu-dropdown:not(.hidden)").forEach((dropdown) => {
      dropdown.classList.add("hidden");
      const trigger = dropdown.closest(".more-menu")?.querySelector(".more-menu-trigger");
      if (trigger) trigger.setAttribute("aria-expanded", "false");
    });
  });
}

function bindThemeControls(ctx) {
  const savedTheme = localStorage.getItem("lisan-theme");

  const applyTheme = (theme) => {
    const root = document.documentElement;
    root.classList.toggle("dark-mode", theme === "dark");
    root.classList.toggle("light-mode", theme === "light");
    localStorage.setItem("lisan-theme", theme);

    if (ctx.els.darkModeToggle) {
      ctx.els.darkModeToggle.innerHTML = theme === "dark"
        ? '<span aria-hidden="true">☀️</span><span>Mode Terang</span>'
        : '<span aria-hidden="true">🌙</span><span>Mode Gelap</span>';
    }
  };

  if (savedTheme === "dark") applyTheme("dark");
  else if (savedTheme === "light") applyTheme("light");

  ctx.els.darkModeToggle?.addEventListener("click", () => {
    const isDark = document.documentElement.classList.contains("dark-mode");
    applyTheme(isDark ? "light" : "dark");
  });
}

function bindMobileNavigation(ctx) {
  if (!ctx.els.hamburgerBtn) return;

  ctx.els.hamburgerBtn.addEventListener("click", () => {
    const sidebar = document.querySelector(".sidebar");
    if (!sidebar) return;

    sidebar.classList.toggle("nav-open");
    ctx.els.hamburgerBtn.classList.toggle("open");
    ctx.els.hamburgerBtn.setAttribute(
      "aria-expanded",
      sidebar.classList.contains("nav-open") ? "true" : "false"
    );
  });

  document.querySelector(".sidebar")?.addEventListener("click", (event) => {
    if (!(event.target.closest(".nav-button") || event.target.closest(".nav-sub-item"))) return;
    if (window.innerWidth > 900) return;

    document.querySelector(".sidebar")?.classList.remove("nav-open");
    ctx.els.hamburgerBtn.classList.remove("open");
    ctx.els.hamburgerBtn.setAttribute("aria-expanded", "false");
  });
}

async function bootstrapAuthenticated(ctx, nextAuth) {
  // Feature modules bind listeners to DOM nodes that live as long as the page.
  // A second session in the same page (e.g. a simulator account switch) would
  // bind them again and every form would submit twice, so continue on a fresh
  // page instead; the new session cookie is already set.
  if (ctx.sessionBootstrapped) {
    window.location.reload();
    return;
  }
  ctx.sessionBootstrapped = true;
  try {
    const featuresPromise = loadAuthenticatedFeatures(nextAuth.user.role);
    await bootstrapCoreApp(ctx, nextAuth);
    const features = await featuresPromise;
    ctx.features = features;

    await applyRoleAccess(ctx);
    await renderRoleState(ctx, features);
    bindAuthenticatedFeatures(ctx, features);

    if (nextAuth.user.role === "admin") {
      features.userManagement?.renderUsers(ctx);
    }

    await refreshSimulatorIfEnabled(ctx);
    showApp(ctx);
  } catch (error) {
    console.error("Authenticated bootstrap failed:", error);
    ctx.features = null;
    showAuth(ctx);
    throw error;
  }
}

export async function initApp() {
  const ctx = createAppContext();
  ctx.auth = await getCurrentUser();
  ctx.onAuthenticated = (nextAuth) => bootstrapAuthenticated(ctx, nextAuth);
  bindAuthEvents(ctx);

  if (!ctx.auth.authenticated) {
    showAuth(ctx);
    bindGlobalNavigation(ctx);
    bindThemeControls(ctx);
    bindMobileNavigation(ctx);
    return;
  }

  await bootstrapAuthenticated(ctx, ctx.auth);
  bindGlobalNavigation(ctx);
  bindThemeControls(ctx);
  bindMobileNavigation(ctx);
}
