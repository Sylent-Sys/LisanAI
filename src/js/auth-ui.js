import { login, registerTenant, logout } from "./api.js";
import { setButtonLoading } from "./dom.js";
import { showToast } from "./toast.js";
import {
  closeRegisterModal,
  handleModalKeyboard,
  openRegisterModal,
} from "./app-context.js";

/**
 * Authentication UI: login form, register modal, logout, and modal keyboard handling.
 * Authenticated bootstrap is delegated to the application entry point so the same
 * role-aware lazy-loading path is used for initial load, login, and registration.
 */
export function bindAuthEvents(ctx) {
  const { els } = ctx;

  document.addEventListener("keydown", (event) => handleModalKeyboard(ctx, event));

  if (els.openRegisterModalBtn) {
    els.openRegisterModalBtn.addEventListener("click", () => openRegisterModal(ctx));
  }

  if (els.closeRegisterModalBtn) {
    els.closeRegisterModalBtn.addEventListener("click", () => closeRegisterModal(ctx));
  }

  if (els.registerModal) {
    els.registerModal.addEventListener("click", (event) => {
      if (event.target === els.registerModal) {
        closeRegisterModal(ctx);
      }
    });
  }

  els.loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setButtonLoading(event.submitter, true, "Login...", "Login");
    try {
      const nextAuth = await login({
        email: els.loginEmail.value,
        password: els.loginPassword.value,
      });
      await ctx.onAuthenticated?.(nextAuth);
    } catch (error) {
      console.error("Login error:", error);
      showToast(error.message || "Login gagal");
    } finally {
      setButtonLoading(event.submitter, false, "Login...", "Login");
    }
  });

  els.registerForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setButtonLoading(event.submitter, true, "Membuat tenant...", "Buat tenant");
    try {
      const nextAuth = await registerTenant({
        tenantName: els.registerTenant.value,
        name: els.registerName.value,
        email: els.registerEmail.value,
        password: els.registerPassword.value,
      });
      closeRegisterModal(ctx);
      await ctx.onAuthenticated?.(nextAuth);
    } catch (error) {
      showToast(error.message);
    } finally {
      setButtonLoading(event.submitter, false, "Membuat tenant...", "Buat tenant");
    }
  });

  // Password strength indicator
  if (els.registerPassword) {
    els.registerPassword.addEventListener("input", () => {
      const val = els.registerPassword.value;
      const bars = document.querySelectorAll("#registerPasswordStrength .password-strength-bar");
      const label = document.getElementById("registerPasswordStrengthLabel");
      if (!bars.length) return;
      let score = 0;
      if (val.length >= 8) score += 1;
      if (/[a-z]/.test(val) && /[A-Z]/.test(val)) score += 1;
      if (/\d/.test(val)) score += 1;
      if (/[^a-zA-Z0-9]/.test(val)) score += 1;
      const level = val.length === 0 ? -1 : score <= 1 ? 0 : score <= 2 ? 1 : 2;
      const levels = ["weak", "medium", "strong"];
      const labels = ["", "Lemah", "Sedang", "Kuat"];
      bars.forEach((bar, i) => {
        bar.className = "password-strength-bar" + (i <= level && level >= 0 ? " " + levels[level] : "");
      });
      if (label) {
        label.textContent = level >= 0 ? labels[level + 1] : "";
        label.className = "password-strength-label" + (level >= 0 ? " " + levels[level] : "");
      }
    });
  }

  els.logoutButton.addEventListener("click", async () => {
    await logout();
    // Start the next session on a fresh page: feature listeners are bound once
    // per page load, and the previous user's rendered data must not stay in
    // the DOM of a shared classroom computer.
    window.location.reload();
  });
}
