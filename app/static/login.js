"use strict";
// Login form handler. Kept as an EXTERNAL file (not inline) so the app can serve
// a strict Content-Security-Policy (script-src 'self') with no inline-script
// exception — a future template injection then cannot execute.
const form = document.getElementById("login-form");
const errBox = document.getElementById("login-error");
const btn = document.getElementById("login-btn");

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  errBox.textContent = "";
  btn.disabled = true;
  btn.textContent = "Signing in…";
  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: document.getElementById("username").value,
        password: document.getElementById("password").value,
      }),
    });
    if (res.ok) {
      window.location.href = "/";
      return;
    }
    const data = await res.json().catch(() => ({}));
    errBox.textContent = data.detail || "Login failed";
  } catch (err) {
    errBox.textContent = "Network error. Please try again.";
  } finally {
    btn.disabled = false;
    btn.textContent = "Sign in";
  }
});
