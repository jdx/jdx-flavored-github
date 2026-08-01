interface HeaderSettingsControllerOptions<ActionGroup> {
  cancelTimer?: (handle: unknown) => void;
  delay?: number;
  getActionGroup: () => ActionGroup | undefined;
  hasButton: () => boolean;
  insertButton: (actionGroup: ActionGroup) => void;
  removeButton: () => void;
  scheduleTimer?: (callback: () => void, delay: number) => unknown;
}

interface HeaderSettingsController {
  handleMutation: () => void;
  setEnabled: (enabled: boolean) => void;
}

export function createHeaderSettingsController<ActionGroup>({
  cancelTimer = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  delay = 1000,
  getActionGroup,
  hasButton,
  insertButton,
  removeButton,
  scheduleTimer = (callback, timeout) => setTimeout(callback, timeout),
}: HeaderSettingsControllerOptions<ActionGroup>): HeaderSettingsController {
  let enabled = false;
  let readyActionGroup: ActionGroup | undefined;
  let refresh: unknown;

  function cancelRefresh(): void {
    if (refresh !== undefined) {
      cancelTimer(refresh);
      refresh = undefined;
    }
  }

  function ensureButton(): void {
    if (!enabled) {
      removeButton();
      return;
    }
    const actionGroup = getActionGroup();
    if (!actionGroup || actionGroup !== readyActionGroup) {
      readyActionGroup = undefined;
      queueReadinessCheck();
      return;
    }
    if (!hasButton()) {
      insertButton(actionGroup);
    }
  }

  function queueReadinessCheck(): void {
    if (!enabled || refresh !== undefined) {
      return;
    }
    refresh = scheduleTimer(() => {
      refresh = undefined;
      if (!enabled) {
        return;
      }
      const actionGroup = getActionGroup();
      if (!actionGroup) {
        readyActionGroup = undefined;
        queueReadinessCheck();
        return;
      }
      readyActionGroup = actionGroup;
      ensureButton();
    }, delay);
  }

  return {
    handleMutation() {
      if (!enabled) {
        removeButton();
        return;
      }
      const actionGroup = getActionGroup();
      if (readyActionGroup && actionGroup !== readyActionGroup) {
        readyActionGroup = undefined;
        cancelRefresh();
        queueReadinessCheck();
        return;
      }
      if (readyActionGroup) {
        ensureButton();
      }
    },
    setEnabled(nextEnabled) {
      enabled = nextEnabled;
      if (!enabled) {
        readyActionGroup = undefined;
        cancelRefresh();
        removeButton();
        return;
      }
      const actionGroup = getActionGroup();
      if (readyActionGroup === actionGroup && actionGroup && hasButton()) {
        return;
      }
      readyActionGroup = undefined;
      cancelRefresh();
      queueReadinessCheck();
    },
  };
}
