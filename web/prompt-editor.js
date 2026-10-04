export class PromptEditor {
  constructor(dialog, { read, write, editable, name }) {
    this.dialog = dialog;
    this.options = { read, write, editable, name };
    this.input = dialog.querySelector("textarea");
    this.save = dialog.querySelector("[data-prompt-save]");
    this.cancel = dialog.querySelector("[data-prompt-cancel]");
    this.input.addEventListener("input", () => {
      this.input.setCustomValidity("");
      this.updateCount();
    });
    this.cancel.addEventListener("click", () => dialog.close());
    dialog
      .querySelector("[data-prompt-close]")
      .addEventListener("click", () => dialog.close());
    dialog.querySelector("form").addEventListener("submit", (event) => {
      event.preventDefault();
      this.commit();
    });
    this.input.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        this.commit();
      }
    });
  }
  open(id) {
    if (this.dialog.open) return;
    this.id = id;
    this.input.value = this.options.read(id);
    this.input.setCustomValidity("");
    this.input.readOnly = !this.options.editable();
    this.save.hidden = this.input.readOnly;
    this.cancel.textContent = this.input.readOnly ? "Закрыть" : "Отмена";
    this.dialog.querySelector("h2").textContent =
      `Стратегия · ${this.options.name(id)}`;
    this.dialog.querySelector("[data-prompt-lock]").hidden =
      !this.input.readOnly;
    this.updateCount();
    this.dialog.showModal();
    this.input.focus();
    this.input.setSelectionRange(0, 0);
    this.input.scrollTop = 0;
  }
  updateCount() {
    this.dialog.querySelector("[data-prompt-count]").textContent =
      `${this.input.value.length} / ${this.input.maxLength}`;
  }
  commit() {
    if (this.input.readOnly || !this.options.editable()) return;
    this.input.setCustomValidity(
      this.input.value.trim() ? "" : "Напиши стратегию бойца.",
    );
    if (!this.input.reportValidity()) return;
    this.options.write(this.id, this.input.value);
    this.dialog.close();
  }
  close() {
    if (this.dialog.open) this.dialog.close();
  }
}
