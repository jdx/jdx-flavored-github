import * as dsl from '../dsl/index.js';
import {defaultOptions} from '../shared/types.js';
import type {NotificationRule, Surface} from '../shared/types.js';

(() => {
  const defaults = defaultOptions;
  const surfaces: Surface[] = ['notifications', 'pulls', 'issues'];
  const status = document.querySelector<HTMLOutputElement>('#status')!;
  const scopeInput = document.querySelector<HTMLSelectElement>('#view-scope')!;
  const scopeHelp = document.querySelector<HTMLElement>('#scope-help')!;
  const removeScopeButton = document.querySelector<HTMLButtonElement>('#remove-scope')!;
  const checkboxIds = {
    autoLoadNotificationPages: 'auto-load-notification-pages',
    collapseDependencyUpdates: 'collapse-dependency-updates',
    collapseSameAuthorNotifications: 'collapse-same-author-notifications',
    dimBotNotifications: 'dim-bot-notifications',
    showHeaderSettingsButton: 'show-header-settings-button',
  };
  const numberIds = {
    autoLoadNotificationTarget: 'auto-load-notification-target',
  };
  const numberLimits = {
    autoLoadNotificationTarget: {max: 200, min: 1},
  };
  const selectedBySurface = {};
  let builtInNotificationRules = dsl.cloneBuiltInNotificationRules();
  let builtInViews = dsl.cloneBuiltInViews();
  let state;

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function isSame(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  function builtInSurface(surface) {
    return surface === 'notifications'
      ? {
          defaultViewId: dsl.builtInDefaultViewIds.notifications,
          rules: clone(builtInNotificationRules),
        }
      : {
          defaultViewId: dsl.builtInDefaultViewIds[surface],
          views: clone(builtInViews[surface]),
        };
  }

  function isSurfaceValue(surface, value) {
    return surface === 'notifications'
      ? Array.isArray(value?.rules) && value.rules.length > 0
      : Array.isArray(value?.views) && value.views.length > 0;
  }

  function getRepositorySurface(repository, surface) {
    const value = state.repositories[repository]?.[surface];
    return isSurfaceValue(surface, value) ? value : undefined;
  }

  function getOwnerSurface(owner, surface) {
    const value = state.owners[owner]?.[surface];
    return isSurfaceValue(surface, value) ? value : undefined;
  }

  function getScopeKind(scope = state.currentScope) {
    if (scope === 'global') {
      return 'global';
    }
    return scope.startsWith('owner:') ? 'owner' : 'repository';
  }

  function getScopeOwner(scope = state.currentScope) {
    return getScopeKind(scope) === 'owner' ? scope.slice('owner:'.length) : scope.split('/')[0];
  }

  function getInheritedSurface(surface, scope = state.currentScope) {
    const kind = getScopeKind(scope);
    if (kind === 'owner') {
      return state.global[surface];
    }
    if (kind === 'repository') {
      return getOwnerSurface(getScopeOwner(scope), surface) ?? state.global[surface];
    }
    return builtInSurface(surface);
  }

  function getDisplayedSurface(surface) {
    const kind = getScopeKind();
    if (kind === 'global') {
      return state.global[surface];
    }
    if (kind === 'owner') {
      return getOwnerSurface(getScopeOwner(), surface) ?? state.global[surface];
    }
    return getRepositorySurface(state.currentScope, surface) ?? getInheritedSurface(surface);
  }

  function ensureEditableSurface(surface) {
    const kind = getScopeKind();
    if (kind === 'global') {
      return state.global[surface];
    }
    if (kind === 'owner') {
      const owner = getScopeOwner();
      state.owners[owner] ??= {};
      if (!isSurfaceValue(surface, state.owners[owner][surface])) {
        state.owners[owner][surface] = clone(getInheritedSurface(surface));
      }
      return state.owners[owner][surface];
    }
    state.repositories[state.currentScope] ??= {};
    if (!isSurfaceValue(surface, state.repositories[state.currentScope][surface])) {
      state.repositories[state.currentScope][surface] = clone(getInheritedSurface(surface));
    }
    return state.repositories[state.currentScope][surface];
  }

  function getItems(surface, value = getDisplayedSurface(surface)) {
    return surface === 'notifications' ? value.rules : value.views;
  }

  function ensureDefault(surface, value) {
    const candidates =
      surface === 'notifications' ? value.rules.filter((rule) => rule.showAsView) : value.views;
    if (!candidates.some((item) => item.id === value.defaultViewId)) {
      value.defaultViewId = candidates[0]?.id;
    }
  }

  function newItem(surface): NotificationRule {
    const item: NotificationRule = {
      id: `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      label: surface === 'notifications' ? 'New rule' : 'New view',
      dsl:
        surface === 'notifications'
          ? 'is:any'
          : `is:open is:${surface === 'pulls' ? 'pr' : 'issue'}`,
    };
    if (surface === 'notifications') {
      item.showAsView = false;
      item.showAsReason = true;
    }
    return item;
  }

  function newBulkAction(surface) {
    const definition = dsl.getBulkActionTypes(surface)[0];
    return {
      id: `action-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      label: definition?.label ?? 'Bulk action',
      steps: definition ? [{type: definition.type}] : [],
    };
  }

  function createBulkActionsEditor(surface, item, mutateItem, rerender) {
    const section = document.createElement('section');
    section.className = 'bulk-actions-editor';
    const heading = document.createElement('div');
    heading.className = 'bulk-actions-heading';
    const title = document.createElement('strong');
    title.textContent = 'Bulk actions';
    const addAction = document.createElement('button');
    addAction.type = 'button';
    addAction.textContent = 'Add action';
    addAction.addEventListener('click', () => {
      mutateItem((editable) => {
        editable.actions ??= [];
        editable.actions.push(newBulkAction(surface));
      });
      rerender();
    });
    heading.append(title, addAction);
    const help = document.createElement('p');
    help.textContent = 'Actions are always previewed before they change matching items.';
    const list = document.createElement('div');
    list.className = 'bulk-actions-list';
    const definitions = dsl.getBulkActionTypes(surface);
    for (const [actionIndex, action] of (item.actions ?? []).entries()) {
      const card = document.createElement('div');
      card.className = 'bulk-action-card';
      const actionHeader = document.createElement('div');
      actionHeader.className = 'bulk-action-header';
      const label = document.createElement('input');
      label.type = 'text';
      label.value = action.label;
      label.setAttribute('aria-label', 'Bulk action name');
      label.addEventListener('input', () => {
        mutateItem((editable) => {
          editable.actions[actionIndex].label = label.value;
        });
      });
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '×';
      remove.title = 'Remove bulk action';
      remove.addEventListener('click', () => {
        mutateItem((editable) => editable.actions.splice(actionIndex, 1));
        rerender();
      });
      actionHeader.append(label, remove);
      const steps = document.createElement('div');
      steps.className = 'bulk-action-steps';
      for (const [stepIndex, step] of action.steps.entries()) {
        const stepRow = document.createElement('div');
        stepRow.className = 'bulk-action-step';
        const select = document.createElement('select');
        select.setAttribute('aria-label', 'Bulk action operation');
        for (const definition of definitions) {
          select.append(new Option(definition.label, definition.type));
        }
        select.value = step.type;
        select.addEventListener('change', () => {
          mutateItem((editable) => {
            editable.actions[actionIndex].steps[stepIndex] = {type: select.value};
          });
          rerender();
        });
        stepRow.append(select);
        const definition = definitions.find((candidate) => candidate.type === step.type);
        if (definition?.needsValue) {
          const value = document.createElement('input');
          value.type = 'text';
          value.value = step.value ?? '';
          value.placeholder = 'Label name';
          value.setAttribute('aria-label', `${definition.label} value`);
          value.addEventListener('input', () => {
            mutateItem((editable) => {
              editable.actions[actionIndex].steps[stepIndex].value = value.value;
            });
          });
          stepRow.append(value);
        }
        const removeStep = document.createElement('button');
        removeStep.type = 'button';
        removeStep.textContent = '×';
        removeStep.title = 'Remove step';
        removeStep.disabled = action.steps.length === 1;
        removeStep.addEventListener('click', () => {
          mutateItem((editable) => {
            editable.actions[actionIndex].steps.splice(stepIndex, 1);
          });
          rerender();
        });
        stepRow.append(removeStep);
        steps.append(stepRow);
      }
      const addStep = document.createElement('button');
      addStep.type = 'button';
      addStep.textContent = 'Add step';
      addStep.addEventListener('click', () => {
        mutateItem((editable) => {
          const first = dsl.getBulkActionTypes(surface)[0];
          editable.actions[actionIndex].steps.push({type: first.type});
        });
        rerender();
      });
      card.append(actionHeader, steps, addStep);
      list.append(card);
    }
    section.append(heading, help, list);
    return section;
  }

  function editItem(surface, itemId, mutate) {
    const value = ensureEditableSurface(surface);
    const item = getItems(surface, value).find((candidate) => candidate.id === itemId);
    if (item) {
      mutate(item, value);
    }
    return item;
  }

  function moveItem(surface, itemId, offset) {
    const value = ensureEditableSurface(surface);
    const items = getItems(surface, value);
    const index = items.findIndex((item) => item.id === itemId);
    const nextIndex = index + offset;
    if (index < 0 || nextIndex < 0 || nextIndex >= items.length) {
      return;
    }
    [items[index], items[nextIndex]] = [items[nextIndex], items[index]];
    renderSurface(surface);
  }

  function removeItem(surface, itemId) {
    const value = ensureEditableSurface(surface);
    const items = getItems(surface, value);
    if (items.length === 1) {
      status.textContent = 'Each surface needs at least one item';
      return;
    }
    const index = items.findIndex((item) => item.id === itemId);
    if (index < 0) {
      return;
    }
    items.splice(index, 1);
    ensureDefault(surface, value);
    selectedBySurface[surface] = items[Math.min(index, items.length - 1)]?.id;
    renderSurface(surface);
  }

  function restoreSurfaceDefaults(surface) {
    const kind = getScopeKind();
    if (kind === 'global') {
      state.global[surface] = builtInSurface(surface);
      status.textContent = `${surface === 'pulls' ? 'Pull request' : surface} defaults restored; save to apply`;
    } else if (kind === 'owner') {
      const owner = getScopeOwner();
      delete state.owners[owner]?.[surface];
      status.textContent = `${surface === 'pulls' ? 'Pull request' : surface} now uses global filters; save to apply`;
    } else {
      delete state.repositories[state.currentScope]?.[surface];
      const parent = getOwnerSurface(getScopeOwner(), surface)
        ? `${getScopeOwner()} filters`
        : 'global filters';
      status.textContent = `${surface === 'pulls' ? 'Pull request' : surface} now uses ${parent}; save to apply`;
    }
    selectedBySurface[surface] = getDisplayedSurface(surface).defaultViewId;
    renderSurface(surface);
  }

  function renderSurface(surface) {
    const editor = document.querySelector<HTMLElement>(`.view-editor[data-surface="${surface}"]`)!;
    const scopeKind = getScopeKind();
    const scoped = scopeKind !== 'global';
    const inherited =
      scopeKind === 'owner'
        ? !getOwnerSurface(getScopeOwner(), surface)
        : scopeKind === 'repository'
          ? !getRepositorySurface(state.currentScope, surface)
          : false;
    editor.hidden = false;
    editor.classList.toggle('view-editor--inherited', inherited);
    const parentLabel =
      scopeKind === 'repository' && getOwnerSurface(getScopeOwner(), surface)
        ? `Use ${getScopeOwner()} filters`
        : 'Use global filters';
    editor.querySelector('.restore-views').textContent = scoped
      ? parentLabel
      : 'Restore default filters';
    editor.querySelector<HTMLButtonElement>('.restore-views')!.disabled = inherited;
    editor.querySelector('.add-view').textContent =
      surface === 'notifications' ? 'Add rule' : 'Add view';

    const value = getDisplayedSurface(surface);
    const items = getItems(surface, value);
    const selected =
      items.find((item) => item.id === selectedBySurface[surface]) ??
      items.find((item) => item.id === value.defaultViewId) ??
      items[0];
    selectedBySurface[surface] = selected?.id;

    const workspace = document.createElement('div');
    workspace.className = 'view-workspace';
    const master = document.createElement('div');
    master.className = 'view-master';
    const detail = document.createElement('div');
    detail.className = 'view-detail';
    workspace.append(master, detail);

    master.replaceChildren(
      ...items.map((item, index) => {
        const row = document.createElement('div');
        row.className = 'view-master-row';
        row.classList.toggle('view-master-row--selected', item.id === selected.id);
        const select = document.createElement('button');
        select.className = 'view-master-select';
        select.type = 'button';
        const name = document.createElement('span');
        name.className = 'view-master-name';
        name.textContent = item.label || 'Untitled';
        const meta = document.createElement('span');
        meta.className = 'view-master-meta';
        const tags = [];
        if (value.defaultViewId === item.id) {
          tags.push('Default');
        }
        if (surface === 'notifications') {
          if (item.showAsView) {
            tags.push('View chip');
          }
          if (item.showAsReason) {
            tags.push('Filtered reason');
          }
          if (!item.showAsView && !item.showAsReason) {
            tags.push('Helper rule');
          }
        }
        if (item.actions?.length) {
          tags.push(
            `${item.actions.length} bulk ${item.actions.length === 1 ? 'action' : 'actions'}`,
          );
        }
        meta.textContent = tags.join(' · ') || 'View';
        select.append(name, meta);
        select.addEventListener('click', () => {
          selectedBySurface[surface] = item.id;
          renderSurface(surface);
        });

        const controls = document.createElement('div');
        controls.className = 'view-controls';
        for (const [label, title, handler, disabled] of [
          ['↑', 'Move up', () => moveItem(surface, item.id, -1), index === 0],
          ['↓', 'Move down', () => moveItem(surface, item.id, 1), index === items.length - 1],
          ['×', 'Delete', () => removeItem(surface, item.id), items.length === 1],
        ] as Array<[string, string, () => void, boolean]>) {
          const button = document.createElement('button');
          button.type = 'button';
          button.textContent = label;
          button.title = title;
          button.disabled = disabled;
          button.addEventListener('click', handler);
          controls.append(button);
        }
        row.append(select, controls);
        return row;
      }),
    );

    if (selected) {
      const detailTitle = document.createElement('strong');
      detailTitle.textContent = `Editing: ${selected.label || 'Untitled'}`;
      let idLabel;
      if (surface === 'notifications') {
        idLabel = document.createElement('label');
        idLabel.className = 'view-field';
        idLabel.append(document.createTextNode('Rule ID'));
        const id = document.createElement('input');
        id.className = 'view-label';
        id.type = 'text';
        id.value = selected.id;
        id.setAttribute('aria-label', 'Rule ID');
        id.addEventListener('change', () => {
          const editable = ensureEditableSurface(surface);
          const item = editable.rules.find((rule) => rule.id === selected.id);
          const nextId = id.value.trim().toLowerCase();
          if (!/^[a-z0-9][a-z0-9-]*$/.test(nextId)) {
            status.textContent = 'Rule IDs use lowercase letters, numbers, and hyphens';
            id.value = item.id;
            return;
          }
          if (editable.rules.some((rule) => rule !== item && rule.id === nextId)) {
            status.textContent = `rule:${nextId} already exists`;
            id.value = item.id;
            return;
          }
          const previousId = item.id;
          for (const rule of editable.rules) {
            rule.dsl = rule.dsl.replace(
              new RegExp(`\\brule:${previousId}(?![a-z0-9-])`, 'gi'),
              `rule:${nextId}`,
            );
          }
          item.id = nextId;
          if (editable.defaultViewId === previousId) {
            editable.defaultViewId = nextId;
          }
          selectedBySurface[surface] = nextId;
          renderSurface(surface);
        });
        idLabel.append(id);
      }
      const nameLabel = document.createElement('label');
      nameLabel.className = 'view-field';
      nameLabel.append(document.createTextNode('Name'));
      const name = document.createElement('input');
      name.className = 'view-label';
      name.type = 'text';
      name.value = selected.label;
      name.setAttribute('aria-label', 'View name');
      name.addEventListener('input', () => {
        editItem(surface, selected.id, (item) => {
          item.label = name.value;
        });
        detailTitle.textContent = `Editing: ${name.value || 'Untitled'}`;
        master.querySelector('.view-master-row--selected .view-master-name').textContent =
          name.value || 'Untitled';
      });
      nameLabel.append(name);

      const dslLabel = document.createElement('label');
      dslLabel.className = 'view-field';
      dslLabel.append(
        document.createTextNode(surface === 'notifications' ? 'Rule DSL' : 'View filter'),
      );
      const expression = document.createElement('textarea');
      expression.className = 'view-dsl';
      expression.value = selected.dsl;
      expression.rows = Math.min(10, Math.max(3, selected.dsl.split('\n').length));
      expression.spellcheck = false;
      expression.setAttribute('aria-label', 'View DSL');
      expression.addEventListener('input', () => {
        editItem(surface, selected.id, (item) => {
          item.dsl = expression.value;
        });
        expression.rows = Math.min(10, Math.max(3, expression.value.split('\n').length));
      });
      dslLabel.append(expression);

      const choices = document.createElement('div');
      choices.className = 'view-choices';
      const defaultLabel = document.createElement('label');
      const radio = document.createElement('input');
      radio.className = 'view-default';
      radio.type = 'radio';
      radio.name = `default-${state.currentScope}-${surface}`;
      radio.checked = value.defaultViewId === selected.id;
      radio.disabled = surface === 'notifications' && !selected.showAsView;
      radio.addEventListener('change', () => {
        const editable = ensureEditableSurface(surface);
        editable.defaultViewId = selected.id;
        renderSurface(surface);
      });
      defaultLabel.append(radio, document.createTextNode('Default view'));
      choices.append(defaultLabel);

      if (surface === 'notifications') {
        for (const [key, text] of [
          ['showAsView', 'Show as view chip'],
          ['showAsReason', 'Use as filtered-reason pill'],
        ]) {
          const label = document.createElement('label');
          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.checked = Boolean(selected[key]);
          checkbox.addEventListener('change', () => {
            const editable = ensureEditableSurface(surface);
            const item = editable.rules.find((rule) => rule.id === selected.id);
            if (
              key === 'showAsView' &&
              !checkbox.checked &&
              editable.rules.filter((rule) => rule.showAsView).length === 1
            ) {
              checkbox.checked = true;
              status.textContent = 'At least one rule must be a view chip';
              return;
            }
            item[key] = checkbox.checked;
            ensureDefault(surface, editable);
            renderSurface(surface);
          });
          label.append(checkbox, document.createTextNode(text));
          choices.append(label);
        }
      }
      detail.append(
        detailTitle,
        ...(idLabel ? [idLabel] : []),
        nameLabel,
        dslLabel,
        choices,
        createBulkActionsEditor(
          surface,
          selected,
          (mutate) => editItem(surface, selected.id, mutate),
          () => renderSurface(surface),
        ),
      );
    }

    editor.querySelector('.view-list').replaceChildren(workspace);
  }

  function renderScopeOptions() {
    const owners = Object.keys(state.owners).sort();
    const repositories = Object.keys(state.repositories).sort();
    const ownerGroup = document.createElement('optgroup');
    ownerGroup.label = 'Users and organizations';
    ownerGroup.append(...owners.map((owner) => new Option(owner, `owner:${owner}`)));
    const repositoryGroup = document.createElement('optgroup');
    repositoryGroup.label = 'Repositories';
    repositoryGroup.append(...repositories.map((repository) => new Option(repository, repository)));
    scopeInput.replaceChildren(new Option('Global views', 'global'));
    if (owners.length > 0) {
      scopeInput.append(ownerGroup);
    }
    if (repositories.length > 0) {
      scopeInput.append(repositoryGroup);
    }
    const validScope =
      state.currentScope === 'global' ||
      (getScopeKind() === 'owner'
        ? Boolean(state.owners[getScopeOwner()])
        : Boolean(state.repositories[state.currentScope]));
    if (!validScope) {
      state.currentScope = 'global';
    }
    scopeInput.value = state.currentScope;
  }

  function renderEditors() {
    renderScopeOptions();
    for (const surface of surfaces) {
      renderSurface(surface);
    }
    const kind = getScopeKind();
    removeScopeButton.hidden = kind === 'global';
    if (kind === 'owner') {
      scopeHelp.textContent = `${getScopeOwner()} inherits each surface from Global until you edit it.`;
    } else if (kind === 'repository') {
      scopeHelp.textContent = `${state.currentScope} inherits each surface from ${getScopeOwner()} when that owner has an override, otherwise Global.`;
    } else {
      scopeHelp.textContent =
        'Global views apply unless a user, organization, or repository supplies an override.';
    }
  }

  function validateSurface(surface, value, scopeLabel) {
    const items = getItems(surface, value);
    if (surface === 'notifications' && !items.some((rule) => rule.showAsView)) {
      throw new Error(`${scopeLabel} notifications need at least one view chip`);
    }
    for (const item of items) {
      item.label = item.label.trim();
      item.dsl = item.dsl.trim();
      if (!item.label || !item.dsl) {
        throw new Error(`A ${scopeLabel} ${surface} item needs a name and filter`);
      }
      if (surface === 'notifications') {
        dsl.parseNotificationDsl(item.dsl);
      }
    }
    if (surface === 'notifications') {
      dsl.validateNotificationRules(items);
    }
    dsl.validateBulkActions(items, surface);
    ensureDefault(surface, value);
  }

  function validateViews() {
    for (const surface of surfaces) {
      validateSurface(surface, state.global[surface], 'global');
    }
    for (const [repository, repositoryOverrides] of Object.entries(state.repositories)) {
      for (const surface of surfaces) {
        const value = repositoryOverrides[surface];
        if (isSurfaceValue(surface, value)) {
          validateSurface(surface, value, repository);
        }
      }
    }
    for (const [owner, ownerOverrides] of Object.entries(state.owners)) {
      for (const surface of surfaces) {
        const value = ownerOverrides[surface];
        if (isSurfaceValue(surface, value)) {
          validateSurface(surface, value, owner);
        }
      }
    }
  }

  function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function normalizeImportedSettings(imported) {
    if (!isObject(imported)) {
      throw new Error('The JSON root must be a settings object');
    }
    const knownKeys = new Set(Object.keys(defaults));
    const unknownKey = Object.keys(imported).find((key) => !knownKeys.has(key));
    if (unknownKey) {
      throw new Error(`Unknown setting “${unknownKey}”`);
    }
    const normalized = {...defaults, ...clone(imported)};
    for (const key of Object.keys(checkboxIds)) {
      if (typeof normalized[key] !== 'boolean') {
        throw new Error(`${key} must be true or false`);
      }
    }
    for (const key of Object.keys(numberIds)) {
      const {max, min} = numberLimits[key];
      if (
        typeof normalized[key] !== 'number' ||
        !Number.isInteger(normalized[key]) ||
        normalized[key] < min ||
        normalized[key] > max
      ) {
        throw new Error(`${key} must be a whole number between ${min} and ${max}`);
      }
    }
    if (!isObject(normalized.viewOverrides)) {
      throw new Error('viewOverrides must be an object');
    }
    if (!isObject(normalized.repositoryViewOverrides)) {
      throw new Error('repositoryViewOverrides must be an object');
    }
    if (!isObject(normalized.ownerViewOverrides)) {
      throw new Error('ownerViewOverrides must be an object');
    }
    const validateOverrides = (overrides, scopeLabel) => {
      for (const [surface, value] of Object.entries(overrides)) {
        if (!surfaces.includes(surface as Surface)) {
          throw new Error(`Unknown ${scopeLabel} surface “${surface}”`);
        }
        const typedSurface = surface as Surface;
        if (!isSurfaceValue(typedSurface, value)) {
          throw new Error(`${scopeLabel} ${surface} has an invalid structure`);
        }
        validateSurface(typedSurface, value, scopeLabel);
      }
    };
    validateOverrides(normalized.viewOverrides, 'global');
    for (const [owner, overrides] of Object.entries(normalized.ownerViewOverrides)) {
      if (!/^[\w.-]+$/.test(owner)) {
        throw new Error(`Invalid user or organization scope “${owner}”`);
      }
      if (!isObject(overrides)) {
        throw new Error(`${owner} overrides must be an object`);
      }
      validateOverrides(overrides, owner);
    }
    for (const [repository, overrides] of Object.entries(normalized.repositoryViewOverrides)) {
      if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) {
        throw new Error(`Invalid repository scope “${repository}”`);
      }
      if (!isObject(overrides)) {
        throw new Error(`${repository} overrides must be an object`);
      }
      validateOverrides(overrides, repository);
    }
    return normalized;
  }

  function buildUpdatedOptions() {
    const updatedOptions = {
      ownerViewOverrides: {},
      repositoryViewOverrides: {},
      viewOverrides: {},
    };
    for (const surface of surfaces) {
      if (!isSame(state.global[surface], builtInSurface(surface))) {
        updatedOptions.viewOverrides[surface] = state.global[surface];
      }
    }
    for (const [repository, repositoryOverrides] of Object.entries(state.repositories)) {
      const owner = repository.split('/')[0];
      for (const surface of surfaces) {
        const value = repositoryOverrides[surface];
        const inherited = getOwnerSurface(owner, surface) ?? state.global[surface];
        if (isSurfaceValue(surface, value) && !isSame(value, inherited)) {
          updatedOptions.repositoryViewOverrides[repository] ??= {};
          updatedOptions.repositoryViewOverrides[repository][surface] = value;
        }
      }
    }
    for (const [owner, ownerOverrides] of Object.entries(state.owners)) {
      for (const surface of surfaces) {
        const value = ownerOverrides[surface];
        if (isSurfaceValue(surface, value) && !isSame(value, state.global[surface])) {
          updatedOptions.ownerViewOverrides[owner] ??= {};
          updatedOptions.ownerViewOverrides[owner][surface] = value;
        }
      }
    }
    for (const [key, id] of Object.entries(checkboxIds)) {
      updatedOptions[key] = document.querySelector<HTMLInputElement>(`#${id}`)!.checked;
    }
    for (const [key, id] of Object.entries(numberIds)) {
      const {max, min} = numberLimits[key];
      const value = Math.round(Number(document.querySelector<HTMLInputElement>(`#${id}`)!.value));
      updatedOptions[key] = Number.isFinite(value)
        ? Math.min(max, Math.max(min, value))
        : defaults[key];
    }
    return updatedOptions;
  }

  async function restore() {
    const stored = {
      ...defaults,
      ...(await chrome.storage.sync.get(Object.keys(defaults))),
    };
    builtInNotificationRules = dsl.cloneBuiltInNotificationRules();
    builtInViews = dsl.cloneBuiltInViews();
    const url = new URL(location.href);
    const targetRepository = url.searchParams.get('repository');
    state = {
      ...stored,
      currentScope: targetRepository ?? 'global',
      global: {},
      owners: clone(stored.ownerViewOverrides),
      repositories: clone(stored.repositoryViewOverrides),
    };
    if (targetRepository) {
      state.repositories[targetRepository] ??= {};
    }
    for (const surface of surfaces) {
      const override = stored.viewOverrides?.[surface];
      state.global[surface] = isSurfaceValue(surface, override)
        ? clone(override)
        : builtInSurface(surface);
      selectedBySurface[surface] = state.global[surface].defaultViewId;
    }
    for (const [key, id] of Object.entries(checkboxIds)) {
      document.querySelector<HTMLInputElement>(`#${id}`)!.checked = state[key];
    }
    for (const [key, id] of Object.entries(numberIds)) {
      document.querySelector<HTMLInputElement>(`#${id}`)!.value = String(
        state[key] ?? defaults[key],
      );
    }
    renderEditors();
  }

  async function save() {
    try {
      validateViews();
    } catch (error) {
      status.textContent = error.message;
      return;
    }

    const updatedOptions = buildUpdatedOptions();

    try {
      await chrome.storage.sync.set(updatedOptions);
    } catch (error) {
      status.textContent = `Save failed: ${error.message}`;
      return;
    }
    state.viewOverrides = updatedOptions.viewOverrides;
    state.ownerViewOverrides = updatedOptions.ownerViewOverrides;
    state.repositoryViewOverrides = updatedOptions.repositoryViewOverrides;
    state.owners = clone(updatedOptions.ownerViewOverrides);
    state.repositories = clone(updatedOptions.repositoryViewOverrides);
    status.textContent = 'Saved';
    setTimeout(() => {
      status.textContent = '';
    }, 1500);
  }

  function exportSettings() {
    try {
      validateViews();
      const json = `${JSON.stringify(buildUpdatedOptions(), null, 2)}\n`;
      const url = URL.createObjectURL(new Blob([json], {type: 'application/json'}));
      const download = document.createElement('a');
      download.href = url;
      download.download = 'jdx-flavored-github-settings.json';
      document.body.append(download);
      download.click();
      download.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      status.textContent = 'Settings exported';
    } catch (error) {
      status.textContent = error.message;
    }
  }

  async function importSettings(file) {
    try {
      const imported = normalizeImportedSettings(JSON.parse(await file.text()));
      await chrome.storage.sync.set(imported);
      await restore();
      status.textContent = 'Settings imported and synced';
    } catch (error) {
      status.textContent = `Import failed: ${error.message}`;
    }
  }

  async function reset() {
    await chrome.storage.sync.set(defaults);
    await restore();
    status.textContent = 'All settings and filters restored';
  }

  for (const editor of document.querySelectorAll<HTMLElement>('.view-editor')) {
    editor.querySelector('.add-view').addEventListener('click', () => {
      const surface = editor.dataset.surface;
      const value = ensureEditableSurface(surface);
      const item = newItem(surface);
      getItems(surface, value).push(item);
      selectedBySurface[surface] = item.id;
      renderSurface(surface);
    });
    editor.querySelector('.restore-views').addEventListener('click', () => {
      restoreSurfaceDefaults(editor.dataset.surface);
    });
  }

  scopeInput.addEventListener('change', () => {
    state.currentScope = scopeInput.value;
    for (const surface of surfaces) {
      selectedBySurface[surface] = getDisplayedSurface(surface).defaultViewId;
    }
    renderEditors();
  });
  document.querySelector('#add-repository')!.addEventListener('click', () => {
    const input = document.querySelector<HTMLInputElement>('#new-repository')!;
    const repository = input.value.trim();
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) {
      status.textContent = 'Use the format owner/repository';
      return;
    }
    state.repositories[repository] ??= {};
    state.currentScope = repository;
    input.value = '';
    renderEditors();
  });
  document.querySelector('#add-owner')!.addEventListener('click', () => {
    const input = document.querySelector<HTMLInputElement>('#new-owner')!;
    const owner = input.value.trim();
    if (!/^[\w.-]+$/.test(owner)) {
      status.textContent = 'Use a GitHub user or organization name';
      return;
    }
    state.owners[owner] ??= {};
    state.currentScope = `owner:${owner}`;
    input.value = '';
    renderEditors();
  });
  removeScopeButton.addEventListener('click', () => {
    const scope = state.currentScope;
    const label = getScopeKind() === 'owner' ? getScopeOwner() : scope;
    if (getScopeKind() === 'owner') {
      delete state.owners[getScopeOwner()];
    } else {
      delete state.repositories[scope];
    }
    state.currentScope = 'global';
    status.textContent = `${label} overrides removed; save to apply`;
    renderEditors();
  });
  document.querySelector('#save')!.addEventListener('click', save);
  document.querySelector('#reset')!.addEventListener('click', reset);
  document.querySelector('#export-settings')!.addEventListener('click', exportSettings);
  const importFileInput = document.querySelector<HTMLInputElement>('#import-settings-file')!;
  document.querySelector('#import-settings')!.addEventListener('click', () => {
    importFileInput.click();
  });
  importFileInput.addEventListener('change', () => {
    const [file] = importFileInput.files;
    importFileInput.value = '';
    if (file) {
      void importSettings(file);
    }
  });
  void restore();
})();
