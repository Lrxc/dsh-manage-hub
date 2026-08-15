// DeepSeek Harness plugin "manage-hub" — browser half.
//
// Registers two settings sections ("Skills" and "MCP") through the standard
// settings.section slot, and talks to the host through plain fetch() against
// the plugin's own /dsh-manage routes (no dependency on the core api client,
// so no core patching is needed to install this plugin).
window.__ModuleLoader__.load({
  id: 'dsh-manage-hub',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    let react_jsx_runtime = require('react/jsx-runtime')
    let react = require('react')
    let _deepseek_ai_dsh_client_ui_primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    // ── styles ────────────────────────────────────────────────────────────────
    var manageStylesId = 'dsh-manage-hub/manage.module.css'
    var manageCss =
      '.smg_section{box-sizing:border-box;flex-direction:column;gap:12px;width:100%;min-height:0;display:flex}.smg_toolbar{flex:none;justify-content:space-between;align-items:center;gap:8px;display:flex}.smg_actions{flex:none;align-items:center;gap:4px;display:flex}.smg_title{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:500;line-height:22px}.smg_hint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}.smg_list{flex-direction:column;gap:8px;min-height:0;padding:2px;display:flex;overflow:auto}.smg_card{box-sizing:border-box;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;flex-direction:column;gap:6px;padding:10px 12px;display:flex}.smg_cardHead{flex:none;align-items:center;justify-content:space-between;gap:8px;min-width:0;display:flex}.smg_cardName{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:20px;white-space:nowrap;text-overflow:ellipsis;overflow:hidden}.smg_cardDesc{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:19px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.smg_cardMeta{flex-wrap:wrap;gap:6px;align-items:center;display:flex}.smg_pill{box-sizing:border-box;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover);border-radius:999px;padding:2px 8px;font-size:11px;line-height:16px;white-space:nowrap}.smg_field{flex-direction:column;gap:4px;min-width:0;display:flex}.smg_fieldLabel{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}.smg_input{box-sizing:border-box;width:100%;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 8px;font-family:inherit;font-size:13px;line-height:20px}.smg_textarea{box-sizing:border-box;width:100%;min-height:110px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 8px;font-family:inherit;font-size:13px;line-height:20px;resize:vertical}.smg_form{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;flex-direction:column;gap:10px;padding:12px;display:flex}.smg_formRow{flex:none;align-items:flex-end;gap:8px;display:flex}.smg_check{align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;display:flex}.smg_error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}.smg_notice{color:var(--dsw-alias-state-success-primary);font-size:12px;line-height:18px}'
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(manageStylesId) + ']') === null) {
      var tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-manage-hub'
      tag.dataset.pluginCss = manageStylesId
      tag.textContent = manageCss
      document.head.appendChild(tag)
    }
    var manageStyles = {
      section: 'smg_section',
      toolbar: 'smg_toolbar',
      actions: 'smg_actions',
      title: 'smg_title',
      hint: 'smg_hint',
      list: 'smg_list',
      card: 'smg_card',
      cardHead: 'smg_cardHead',
      cardName: 'smg_cardName',
      cardDesc: 'smg_cardDesc',
      cardMeta: 'smg_cardMeta',
      pill: 'smg_pill',
      field: 'smg_field',
      fieldLabel: 'smg_fieldLabel',
      input: 'smg_input',
      textarea: 'smg_textarea',
      form: 'smg_form',
      formRow: 'smg_formRow',
      check: 'smg_check',
      error: 'smg_error',
      notice: 'smg_notice',
    }

    var { useState: useManageState, useEffect: useManageEffect, useCallback: useManageCallback, useRef: useManageRef } = react

    /** Human message of a thrown value. */
    function manageMessageOf(error) {
      return error instanceof Error ? error.message : String(error)
    }

    /** One labeled field row inside a management form. */
    function ManageField({ label, children }) {
      return react_jsx_runtime.jsxs('label', {
        className: manageStyles.field,
        children: [
          react_jsx_runtime.jsx('span', { className: manageStyles.fieldLabel, children: label }),
          children,
        ],
      })
    }

    /**
     * POST one /dsh-manage route and shape the reply like the core api client
     * ({ result: { ok, value | error } }) so the section components stay
     * transport-agnostic.
     */
    function callHost(path, payload) {
      return fetch('/dsh-manage/' + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ payload: payload ?? {} }),
      })
        .then((response) => {
          if (!response.ok) {
            return response
              .json()
              .catch(() => ({}))
              .then((body) => {
                throw new Error((body.error && body.error.message) || 'HTTP ' + response.status)
              })
          }
          return response.json()
        })
        .then((body) => ({ result: body }))
    }

    /** The api-shaped face the sections consume. */
    function buildManageApi() {
      return {
        skills: {
          manage: {
            list: () => callHost('skill.list', {}),
            install: (payload) => callHost('skill.install', payload),
            enable: (payload) => callHost('skill.enable', payload),
            remove: (payload) => callHost('skill.remove', payload),
          },
        },
        mcp: {
          list: () => callHost('mcp.list', {}),
          upsert: (payload) => callHost('mcp.upsert', payload),
          remove: (payload) => callHost('mcp.remove', payload),
          test: (payload) => callHost('mcp.test', payload),
        },
      }
    }

    /** Split textarea lines into an array of non-empty trimmed lines. */
    function manageLines(text) {
      return text.split('\n').map((line) => line.trim()).filter((line) => line !== '')
    }

    /** Parse `KEY=VALUE` lines into a record. */
    function manageKeyValue(text) {
      var result = {}
      for (var i = 0; i < manageLines(text).length; i++) {
        var line = manageLines(text)[i]
        var index = line.indexOf('=')
        var key = (index === -1 ? line : line.slice(0, index)).trim()
        var value = index === -1 ? '' : line.slice(index + 1).trim()
        if (key !== '') result[key] = value
      }
      return result
    }

    /** Build the mcp.upsert server object from a form draft. */
    function mcpDraftToServer(draft) {
      return {
        name: draft.name,
        enabled: draft.enabled,
        transport: draft.transport,
        toolCallTimeoutMs: Number(draft.toolCallTimeoutMs) || 30000,
        failOnStartupError: draft.failOnStartupError,
        ...(draft.transport === 'stdio'
          ? { command: draft.command, args: manageLines(draft.argsText), env: manageKeyValue(draft.envText), cwd: draft.cwd }
          : { url: draft.url, headers: manageKeyValue(draft.headersText) }),
      }
    }

    /** Build a form draft from a server object (for edit + JSON→form sync). */
    function mcpServerToDraft(server) {
      return {
        name: server.name ?? '',
        enabled: server.enabled !== false,
        transport: server.transport ?? 'stdio',
        command: server.command ?? '',
        argsText: (server.args ?? []).join('\n'),
        envText: Object.entries(server.env ?? {}).map(([key, value]) => key + '=' + value).join('\n'),
        cwd: server.cwd ?? '',
        url: server.url ?? '',
        headersText: Object.entries(server.headers ?? {}).map(([key, value]) => key + ': ' + value).join('\n'),
        toolCallTimeoutMs: String(server.toolCallTimeoutMs ?? 30000),
        failOnStartupError: server.failOnStartupError === true,
      }
    }

    /** Read a browser File as a base64 string (for zip upload). */
    function readFileAsBase64(file) {
      return new Promise((resolvePromise, reject) => {
        const reader = new FileReader()
        reader.onload = () => {
          const result = reader.result
          if (typeof result !== 'string') {
            reject(new Error('failed to read file'))
            return
          }
          const comma = result.indexOf(',')
          resolvePromise(comma === -1 ? result : result.slice(comma + 1))
        }
        reader.onerror = () => {
          reject(reader.error instanceof Error ? reader.error : new Error('failed to read file'))
        }
        reader.readAsDataURL(file)
      })
    }

    /**
     * The Skills settings page: user-owned skill catalog with zip import and
     * delete; import opens the file picker directly (no inline editing).
     */
    function SkillsSection({ api, t }) {
      var manageApi = api.skills.manage
      var [skills, setSkills] = useManageState([])
      var [status, setStatus] = useManageState('loading')
      var [error, setError] = useManageState(null)
      var [notice, setNotice] = useManageState(null)
      var [busy, setBusy] = useManageState(false)
      var fileInputRef = useManageRef(null)

      var load = useManageCallback(async () => {
        setStatus('loading')
        setError(null)
        try {
          var response = await manageApi.list({})
          if (!response.result.ok) throw new Error(response.result.error.message)
          setSkills(response.result.value.skills)
          setStatus('ready')
        } catch (cause) {
          setError(manageMessageOf(cause))
          setStatus('error')
        }
      }, [manageApi])
      useManageEffect(() => {
        load()
      }, [load])

      var handleImportFile = useManageCallback(async (file) => {
        setBusy(true)
        setError(null)
        setNotice(null)
        try {
          var data = await readFileAsBase64(file)
          var response = await manageApi.install({ data, filename: file.name })
          if (!response.result.ok) throw new Error(response.result.error.message)
          var importedNames = response.result.value.names ?? []
          setNotice(importedNames.length > 1 ? t('skills.importedMany').replace('{count}', String(importedNames.length)) : t('skills.imported'))
          await load()
        } catch (cause) {
          setError(manageMessageOf(cause))
        } finally {
          setBusy(false)
        }
      }, [manageApi, load, t])

      var remove = useManageCallback(async (name) => {
        if (!window.confirm(t('skills.removeConfirm').replace('{name}', name))) return
        setBusy(true)
        setError(null)
        setNotice(null)
        try {
          var response = await manageApi.remove({ name })
          if (!response.result.ok) throw new Error(response.result.error.message)
          setNotice(t('skills.removed'))
          await load()
        } catch (cause) {
          setError(manageMessageOf(cause))
        } finally {
          setBusy(false)
        }
      }, [manageApi, load, t])

      var toggleEnabled = useManageCallback(async (name, enabled) => {
        setBusy(true)
        setError(null)
        setNotice(null)
        try {
          var response = await manageApi.enable({ name, enabled })
          if (!response.result.ok) throw new Error(response.result.error.message)
          await load()
        } catch (cause) {
          setError(manageMessageOf(cause))
        } finally {
          setBusy(false)
        }
      }, [manageApi, load])

      return react_jsx_runtime.jsxs('div', {
        className: manageStyles.section,
        children: [
          react_jsx_runtime.jsxs('div', {
            className: manageStyles.toolbar,
            children: [
              react_jsx_runtime.jsx('div', { className: manageStyles.title, children: t('skills.title') }),
              react_jsx_runtime.jsxs('div', {
                className: manageStyles.actions,
                children: [
                  react_jsx_runtime.jsx(_deepseek_ai_dsh_client_ui_primitives.Button, {
                    variant: 'ghost',
                    size: 'sm',
                    icon: react_jsx_runtime.jsx(_deepseek_ai_dsh_client_ui_primitives.IconRefreshOutline16, { size: 14 }),
                    disabled: busy,
                    onClick: () => {
                      load()
                    },
                    children: t('skills.refresh'),
                  }),
                  react_jsx_runtime.jsx(_deepseek_ai_dsh_client_ui_primitives.Button, {
                    variant: 'primary',
                    size: 'sm',
                    icon: react_jsx_runtime.jsx(_deepseek_ai_dsh_client_ui_primitives.IconPlusOutline16, { size: 14 }),
                    disabled: busy,
                    onClick: () => {
                      if (fileInputRef.current !== null) fileInputRef.current.click()
                    },
                    children: t('skills.new'),
                  }),
                ],
              }),
            ],
          }),
          notice === null ? null : react_jsx_runtime.jsx('div', { className: manageStyles.notice, children: notice }),
          error === null ? null : react_jsx_runtime.jsx('div', { className: manageStyles.error, children: error }),
          react_jsx_runtime.jsx('input', {
            ref: fileInputRef,
            type: 'file',
            accept: '.zip,application/zip',
            style: { display: 'none' },
            onChange: (event) => {
              var file = event.target.files && event.target.files[0] ? event.target.files[0] : null
              if (file !== null) handleImportFile(file)
              event.target.value = ''
            },
          }),
          react_jsx_runtime.jsx('div', {
            className: manageStyles.list,
            children:
              status === 'loading'
                ? react_jsx_runtime.jsx('div', { className: manageStyles.hint, children: t('skills.loading') })
                : skills.length === 0
                  ? react_jsx_runtime.jsx('div', { className: manageStyles.hint, children: t('skills.empty') })
                  : skills.map((skill) =>
                      react_jsx_runtime.jsxs(
                        'div',
                        {
                          className: manageStyles.card,
                          children: [
                            react_jsx_runtime.jsxs('div', {
                              className: manageStyles.cardHead,
                              children: [
                                react_jsx_runtime.jsx('span', { className: manageStyles.cardName, children: skill.name }),
                                react_jsx_runtime.jsxs('div', {
                                  className: manageStyles.actions,
                                  children: [
                                    react_jsx_runtime.jsxs('label', {
                                      className: manageStyles.check,
                                      children: [
                                        react_jsx_runtime.jsx('input', {
                                          type: 'checkbox',
                                          checked: skill.modelInvocable,
                                          disabled: busy,
                                          onChange: (event) => {
                                            toggleEnabled(skill.name, event.target.checked)
                                          },
                                        }),
                                        t('skills.enabled'),
                                      ],
                                    }),
                                    react_jsx_runtime.jsx(_deepseek_ai_dsh_client_ui_primitives.Button, {
                                      variant: 'ghost',
                                      size: 'sm',
                                      icon: react_jsx_runtime.jsx(_deepseek_ai_dsh_client_ui_primitives.IconTrashOutline16, { size: 14 }),
                                      disabled: busy,
                                      onClick: () => {
                                        remove(skill.name)
                                      },
                                      children: t('skills.remove'),
                                    }),
                                  ],
                                }),
                              ],
                            }),
                            react_jsx_runtime.jsx('div', { className: manageStyles.cardDesc, title: skill.description, children: skill.description }),
                            react_jsx_runtime.jsxs('div', {
                              className: manageStyles.cardMeta,
                              children: [
                                skill.whenToUse !== undefined ? react_jsx_runtime.jsx('span', { className: manageStyles.pill, children: skill.whenToUse }) : null,
                              ],
                            }),
                          ],
                        },
                        skill.name,
                      ),
                    ),
          }),
        ],
      })
    }

    /**
     * The MCP settings page: managed server catalog with add / edit / remove
     * and a per-server connection test.
     */
    function McpSection({ api, t }) {
      var mcpApi = api.mcp
      var [servers, setServers] = useManageState([])
      var [status, setStatus] = useManageState('loading')
      var [error, setError] = useManageState(null)
      var [notice, setNotice] = useManageState(null)
      var [editing, setEditing] = useManageState(null)
      var [busy, setBusy] = useManageState(false)
      var [testing, setTesting] = useManageState(null)
      var [draft, setDraft] = useManageState(null)
      var [jsonMode, setJsonMode] = useManageState(false)
      var [jsonText, setJsonText] = useManageState('')

      var load = useManageCallback(async () => {
        setStatus('loading')
        setError(null)
        try {
          var response = await mcpApi.list({})
          if (!response.result.ok) throw new Error(response.result.error.message)
          setServers(response.result.value.servers)
          setStatus('ready')
        } catch (cause) {
          setError(manageMessageOf(cause))
          setStatus('error')
        }
      }, [mcpApi])
      useManageEffect(() => {
        load()
      }, [load])

      var openForm = useManageCallback((server) => {
        setDraft(mcpServerToDraft(server ?? { name: '', enabled: true, transport: 'stdio' }))
        setEditing(server ?? null)
        setJsonMode(false)
        setJsonText('')
        setError(null)
        setNotice(null)
      }, [])

      var setDraftField = useManageCallback((field, value) => {
        setDraft((previous) => (previous === null ? previous : { ...previous, [field]: value }))
      }, [])

      var toggleJsonMode = useManageCallback(() => {
        if (jsonMode) {
          try {
            var server = JSON.parse(jsonText)
            if (server !== null && typeof server === 'object' && !Array.isArray(server)) {
              setDraft(mcpServerToDraft(server))
            }
          } catch {}
          setJsonMode(false)
        } else {
          if (draft !== null) setJsonText(JSON.stringify(mcpDraftToServer(draft), null, 2))
          setJsonMode(true)
        }
      }, [jsonMode, draft, jsonText])

      var submit = useManageCallback(async () => {
        if (draft === null) return
        setBusy(true)
        setError(null)
        setNotice(null)
        try {
          var server
          if (jsonMode) {
            try {
              server = JSON.parse(jsonText)
            } catch (parseError) {
              throw new Error(t('mcp.form.jsonError').replace('{message}', parseError instanceof Error ? parseError.message : String(parseError)))
            }
          } else {
            server = mcpDraftToServer(draft)
          }
          var response = await mcpApi.upsert({ server })
          if (!response.result.ok) throw new Error(response.result.error.message)
          setEditing(null)
          setDraft(null)
          setJsonMode(false)
          setJsonText('')
          setNotice(t('mcp.saved'))
          await load()
        } catch (cause) {
          setError(manageMessageOf(cause))
        } finally {
          setBusy(false)
        }
      }, [draft, jsonMode, jsonText, mcpApi, load, t])

      var remove = useManageCallback(async (name) => {
        if (!window.confirm(t('mcp.removeConfirm').replace('{name}', name))) return
        setBusy(true)
        setError(null)
        setNotice(null)
        try {
          var response = await mcpApi.remove({ name })
          if (!response.result.ok) throw new Error(response.result.error.message)
          setNotice(t('mcp.removed'))
          await load()
        } catch (cause) {
          setError(manageMessageOf(cause))
        } finally {
          setBusy(false)
        }
      }, [mcpApi, load, t])

      var test = useManageCallback(async (name) => {
        setTesting(name)
        setError(null)
        setNotice(null)
        try {
          var response = await mcpApi.test({ name })
          if (!response.result.ok) throw new Error(response.result.error.message)
          setNotice(t('mcp.test.ok').replace('{count}', String(response.result.value.tools.length)))
        } catch (cause) {
          setError(t('mcp.test.fail').replace('{message}', manageMessageOf(cause)))
        } finally {
          setTesting(null)
        }
      }, [mcpApi, t])

      var closeForm = useManageCallback(() => {
        setEditing(null)
        setDraft(null)
      }, [])

      return react_jsx_runtime.jsxs('div', {
        className: manageStyles.section,
        children: [
          react_jsx_runtime.jsxs('div', {
            className: manageStyles.toolbar,
            children: [
              react_jsx_runtime.jsx('div', { className: manageStyles.title, children: t('mcp.title') }),
              react_jsx_runtime.jsxs('div', {
                className: manageStyles.actions,
                children: [
                  react_jsx_runtime.jsx(_deepseek_ai_dsh_client_ui_primitives.Button, {
                    variant: 'ghost',
                    size: 'sm',
                    icon: react_jsx_runtime.jsx(_deepseek_ai_dsh_client_ui_primitives.IconRefreshOutline16, { size: 14 }),
                    disabled: busy,
                    onClick: () => {
                      load()
                    },
                    children: t('mcp.refresh'),
                  }),
                  react_jsx_runtime.jsx(_deepseek_ai_dsh_client_ui_primitives.Button, {
                    variant: 'primary',
                    size: 'sm',
                    icon: react_jsx_runtime.jsx(_deepseek_ai_dsh_client_ui_primitives.IconPlusOutline16, { size: 14 }),
                    onClick: () => {
                      openForm(null)
                    },
                    children: t('mcp.new'),
                  }),
                ],
              }),
            ],
          }),
          react_jsx_runtime.jsx('div', { className: manageStyles.hint, children: t('mcp.restartHint') }),
          notice === null ? null : react_jsx_runtime.jsx('div', { className: manageStyles.notice, children: notice }),
          error === null ? null : react_jsx_runtime.jsx('div', { className: manageStyles.error, children: error }),
          draft !== null
            ? react_jsx_runtime.jsxs('div', {
                className: manageStyles.form,
                children: [
                  react_jsx_runtime.jsxs('div', {
                    className: manageStyles.toolbar,
                    children: [
                      react_jsx_runtime.jsx('div', { className: manageStyles.title, children: editing === null ? t('mcp.new') : t('mcp.edit') }),
                      react_jsx_runtime.jsxs('div', {
                        className: manageStyles.actions,
                        children: [
                          react_jsx_runtime.jsx(_deepseek_ai_dsh_client_ui_primitives.Button, {
                            variant: 'ghost',
                            size: 'sm',
                            disabled: busy,
                            onClick: closeForm,
                            children: t('mcp.cancel'),
                          }),
                          react_jsx_runtime.jsx(_deepseek_ai_dsh_client_ui_primitives.Button, {
                            variant: 'primary',
                            size: 'sm',
                            disabled: busy || (jsonMode ? jsonText.trim() === '' : draft.name.trim() === '' || (draft.transport === 'stdio' ? draft.command.trim() === '' : draft.url.trim() === '')),
                            onClick: () => {
                              submit()
                            },
                            children: editing === null ? t('mcp.form.add') : t('mcp.form.save'),
                          }),
                        ],
                      }),
                    ],
                  }),
                  react_jsx_runtime.jsxs('div', {
                    className: manageStyles.formRow,
                    children: [
                      react_jsx_runtime.jsxs('label', {
                        className: manageStyles.check,
                        children: [
                          react_jsx_runtime.jsx('input', {
                            type: 'checkbox',
                            checked: jsonMode,
                            onChange: toggleJsonMode,
                          }),
                          t('mcp.form.jsonMode'),
                        ],
                      }),
                      jsonMode
                        ? null
                        : react_jsx_runtime.jsxs('label', {
                            className: manageStyles.check,
                            children: [
                              react_jsx_runtime.jsx('input', {
                                type: 'checkbox',
                                checked: draft.enabled,
                                onChange: (event) => {
                                  setDraftField('enabled', event.target.checked)
                                },
                              }),
                              t('mcp.form.enabled'),
                            ],
                          }),
                    ],
                  }),
                  jsonMode
                    ? [
                        react_jsx_runtime.jsx('textarea', {
                          className: manageStyles.textarea,
                          value: jsonText,
                          onChange: (event) => {
                            setJsonText(event.target.value)
                          },
                        }),
                      ]
                    : [
                  react_jsx_runtime.jsx(ManageField, {
                    label: t('mcp.form.name'),
                    children: react_jsx_runtime.jsx('input', {
                      className: manageStyles.input,
                      value: draft.name,
                      placeholder: 'my-server',
                      disabled: editing !== null,
                      onChange: (event) => {
                        setDraftField('name', event.target.value)
                      },
                    }),
                  }),
                  react_jsx_runtime.jsx(ManageField, {
                    label: t('mcp.form.transport'),
                    children: react_jsx_runtime.jsxs(
                      'select',
                      {
                        className: manageStyles.input,
                        value: draft.transport,
                        onChange: (event) => {
                          setDraftField('transport', event.target.value)
                        },
                        children: [
                          react_jsx_runtime.jsx('option', { value: 'stdio', children: t('mcp.stdio') }),
                          react_jsx_runtime.jsx('option', { value: 'streamable-http', children: t('mcp.streamable-http') }),
                        ],
                      },
                    ),
                  }),
                  draft.transport === 'stdio'
                    ? react_jsx_runtime.jsxs(react_jsx_runtime.Fragment, {
                        children: [
                          react_jsx_runtime.jsx(ManageField, {
                            label: t('mcp.form.command'),
                            children: react_jsx_runtime.jsx('input', {
                              className: manageStyles.input,
                              value: draft.command,
                              placeholder: 'npx',
                              onChange: (event) => {
                                setDraftField('command', event.target.value)
                              },
                            }),
                          }),
                          react_jsx_runtime.jsx(ManageField, {
                            label: t('mcp.form.args'),
                            children: react_jsx_runtime.jsx('textarea', {
                              className: manageStyles.textarea,
                              value: draft.argsText,
                              onChange: (event) => {
                                setDraftField('argsText', event.target.value)
                              },
                            }),
                          }),
                          react_jsx_runtime.jsx(ManageField, {
                            label: t('mcp.form.env'),
                            children: react_jsx_runtime.jsx('textarea', {
                              className: manageStyles.textarea,
                              value: draft.envText,
                              onChange: (event) => {
                                setDraftField('envText', event.target.value)
                              },
                            }),
                          }),
                          react_jsx_runtime.jsx(ManageField, {
                            label: t('mcp.form.cwd'),
                            children: react_jsx_runtime.jsx('input', {
                              className: manageStyles.input,
                              value: draft.cwd,
                              onChange: (event) => {
                                setDraftField('cwd', event.target.value)
                              },
                            }),
                          }),
                        ],
                      })
                    : react_jsx_runtime.jsxs(react_jsx_runtime.Fragment, {
                        children: [
                          react_jsx_runtime.jsx(ManageField, {
                            label: t('mcp.form.url'),
                            children: react_jsx_runtime.jsx('input', {
                              className: manageStyles.input,
                              value: draft.url,
                              placeholder: 'http://127.0.0.1:9000/mcp',
                              onChange: (event) => {
                                setDraftField('url', event.target.value)
                              },
                            }),
                          }),
                          react_jsx_runtime.jsx(ManageField, {
                            label: t('mcp.form.headers'),
                            children: react_jsx_runtime.jsx('textarea', {
                              className: manageStyles.textarea,
                              value: draft.headersText,
                              onChange: (event) => {
                                setDraftField('headersText', event.target.value)
                              },
                            }),
                          }),
                        ],
                      }),
                  react_jsx_runtime.jsx(ManageField, {
                    label: t('mcp.form.timeout'),
                    children: react_jsx_runtime.jsx('input', {
                      className: manageStyles.input,
                      value: draft.toolCallTimeoutMs,
                      type: 'number',
                      min: '1',
                      onChange: (event) => {
                        setDraftField('toolCallTimeoutMs', event.target.value)
                      },
                    }),
                  }),
                  ],
                ],
              })
            : null,
          react_jsx_runtime.jsx('div', {
            className: manageStyles.list,
            children:
              status === 'loading'
                ? react_jsx_runtime.jsx('div', { className: manageStyles.hint, children: t('mcp.loading') })
                : servers.length === 0
                  ? react_jsx_runtime.jsx('div', { className: manageStyles.hint, children: t('mcp.empty') })
                  : servers.map((server) =>
                      react_jsx_runtime.jsxs(
                        'div',
                        {
                          className: manageStyles.card,
                          children: [
                            react_jsx_runtime.jsxs('div', {
                              className: manageStyles.cardHead,
                              children: [
                                react_jsx_runtime.jsx('span', { className: manageStyles.cardName, children: server.name }),
                                react_jsx_runtime.jsxs('div', {
                                  className: manageStyles.cardMeta,
                                  children: [
                                    react_jsx_runtime.jsx('span', {
                                      className: manageStyles.pill,
                                      children: server.transport === 'stdio' ? t('mcp.stdio') : t('mcp.streamable-http'),
                                    }),
                                    react_jsx_runtime.jsx('span', {
                                      className: manageStyles.pill,
                                      children: server.enabled === false ? t('mcp.disabled') : t('mcp.enabled'),
                                    }),
                                  ],
                                }),
                                react_jsx_runtime.jsxs('div', {
                                  className: manageStyles.actions,
                                  children: [
                                    react_jsx_runtime.jsx(_deepseek_ai_dsh_client_ui_primitives.Button, {
                                      variant: 'ghost',
                                      size: 'sm',
                                      icon:
                                        testing === server.name
                                          ? react_jsx_runtime.jsx(_deepseek_ai_dsh_client_ui_primitives.IconLoadingOutline16, { size: 14 })
                                          : react_jsx_runtime.jsx(_deepseek_ai_dsh_client_ui_primitives.IconPlayOutline16, { size: 14 }),
                                      disabled: busy || testing !== null,
                                      onClick: () => {
                                        test(server.name)
                                      },
                                      children: testing === server.name ? t('mcp.testing') : t('mcp.test'),
                                    }),
                                    react_jsx_runtime.jsx(_deepseek_ai_dsh_client_ui_primitives.Button, {
                                      variant: 'ghost',
                                      size: 'sm',
                                      icon: react_jsx_runtime.jsx(_deepseek_ai_dsh_client_ui_primitives.IconEditOutline16, { size: 14 }),
                                      disabled: busy || testing !== null,
                                      onClick: () => {
                                        openForm(server)
                                      },
                                      children: t('mcp.edit'),
                                    }),
                                    react_jsx_runtime.jsx(_deepseek_ai_dsh_client_ui_primitives.Button, {
                                      variant: 'ghost',
                                      size: 'sm',
                                      icon: react_jsx_runtime.jsx(_deepseek_ai_dsh_client_ui_primitives.IconTrashOutline16, { size: 14 }),
                                      disabled: busy || testing !== null,
                                      onClick: () => {
                                        remove(server.name)
                                      },
                                      children: t('mcp.remove'),
                                    }),
                                  ],
                                }),
                              ],
                            }),
                            react_jsx_runtime.jsx('div', {
                              className: manageStyles.cardDesc,
                              title: server.transport === 'stdio' ? server.command + ' ' + (server.args ?? []).join(' ') : server.url,
                              children: server.transport === 'stdio' ? server.command + ' ' + (server.args ?? []).join(' ') : server.url,
                            }),
                          ],
                        },
                        server.name,
                      ),
                    ),
          }),
        ],
      })
    }

    // ── copy dictionaries ──────────────────────────────────────────────────────
    var MANAGE_NS = 'settings-manage'
    var manageZh = {
      'skills.nav': 'Skills',
      'skills.title': 'Skills管理',
      'skills.refresh': '刷新',
      'skills.new': '导入技能',
      'skills.loading': '加载中…',
      'skills.empty': '还没有技能。点击“导入技能”导入第一个。',
      'skills.remove': '删除',
      'skills.removeConfirm': '确定删除技能 {name} 吗？该操作会删除其目录。',
      'skills.imported': '已导入技能。',
      'skills.importedMany': '已导入 {count} 个技能。',
      'skills.removed': '已删除。',
      'skills.enabled': '启用',
      'mcp.nav': 'MCP',
      'mcp.title': 'MCP 服务器',
      'mcp.refresh': '刷新',
      'mcp.new': '添加服务器',
      'mcp.loading': '加载中…',
      'mcp.empty': '还没有配置 MCP 服务器。',
      'mcp.enabled': '已启用',
      'mcp.disabled': '已停用',
      'mcp.stdio': 'stdio',
      'mcp.streamable-http': 'Streamable HTTP',
      'mcp.test': '测试',
      'mcp.testing': '测试中…',
      'mcp.edit': '编辑',
      'mcp.remove': '删除',
      'mcp.removeConfirm': '确定删除 MCP 服务器 {name} 吗？',
      'mcp.restartHint': '新增或修改的服务器会在重启 dsh 后自动连接并注册工具。',
      'mcp.form.name': '名称（仅字母数字与 _-，最长 32）',
      'mcp.form.transport': '传输方式',
      'mcp.form.command': '命令',
      'mcp.form.args': '参数（每行一个）',
      'mcp.form.env': '环境变量（KEY=VALUE，每行一个）',
      'mcp.form.cwd': '工作目录（可选）',
      'mcp.form.url': 'URL',
      'mcp.form.headers': '请求头（Name: Value，每行一个）',
      'mcp.form.timeout': '单次调用超时（毫秒）',
      'mcp.form.enabled': '启用',
      'mcp.form.jsonMode': 'JSON 模式',
      'mcp.form.jsonError': 'JSON 解析失败：{message}',
      'mcp.form.add': '添加',
      'mcp.form.save': '保存',
      'mcp.cancel': '取消',
      'mcp.test.ok': '连接成功，发现 {count} 个工具',
      'mcp.test.fail': '连接失败：{message}',
      'mcp.saved': '已保存。',
      'mcp.removed': '已删除。',
    }
    var manageEn = {
      'skills.nav': 'Skills',
      'skills.title': 'Skills Management',
      'skills.refresh': 'Refresh',
      'skills.new': 'Import skill',
      'skills.loading': 'Loading…',
      'skills.empty': 'No skills yet. Click “Import skill” to import one.',
      'skills.remove': 'Remove',
      'skills.removeConfirm': 'Remove skill {name}? Its directory will be deleted.',
      'skills.imported': 'Skill imported.',
      'skills.importedMany': 'Imported {count} skills.',
      'skills.removed': 'Removed.',
      'skills.enabled': 'Enabled',
      'mcp.nav': 'MCP',
      'mcp.title': 'MCP Servers',
      'mcp.refresh': 'Refresh',
      'mcp.new': 'Add server',
      'mcp.loading': 'Loading…',
      'mcp.empty': 'No MCP servers configured yet.',
      'mcp.enabled': 'Enabled',
      'mcp.disabled': 'Disabled',
      'mcp.stdio': 'stdio',
      'mcp.streamable-http': 'Streamable HTTP',
      'mcp.test': 'Test',
      'mcp.testing': 'Testing…',
      'mcp.edit': 'Edit',
      'mcp.remove': 'Remove',
      'mcp.removeConfirm': 'Remove MCP server {name}?',
      'mcp.restartHint': 'New or changed servers connect automatically after a dsh restart.',
      'mcp.form.name': 'Name (alphanumeric, _ and - only, max 32)',
      'mcp.form.transport': 'Transport',
      'mcp.form.command': 'Command',
      'mcp.form.args': 'Arguments (one per line)',
      'mcp.form.env': 'Environment (KEY=VALUE, one per line)',
      'mcp.form.cwd': 'Working directory (optional)',
      'mcp.form.url': 'URL',
      'mcp.form.headers': 'Headers (Name: Value, one per line)',
      'mcp.form.timeout': 'Per-call timeout (ms)',
      'mcp.form.enabled': 'Enabled',
      'mcp.form.jsonMode': 'JSON mode',
      'mcp.form.jsonError': 'Invalid JSON: {message}',
      'mcp.form.add': 'Add',
      'mcp.form.save': 'Save',
      'mcp.cancel': 'Cancel',
      'mcp.test.ok': 'Connected; found {count} tools',
      'mcp.test.fail': 'Connection failed: {message}',
      'mcp.saved': 'Saved.',
      'mcp.removed': 'Removed.',
    }

    /** Required services (cordis fiber inject). */
    var inject = ['slots', 'locale']

    /**
     * Register the Skills and MCP sections once the `settings.section`
     * declaration is on the ledger.
     * @param ctx - client root context.
     */
    function apply(ctx) {
      ctx.effect(
        () =>
          ctx.locale.register(MANAGE_NS, {
            zh: manageZh,
            en: manageEn,
          }),
        'manage-hub: dictionaries',
      )
      var t = ctx.locale.bind(MANAGE_NS)
      var api = buildManageApi()
      var injected = () => ({ api, t })
      ctx.slots.inject(
        'settings.section',
        () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'skills',
              order: 30,
              label: () => t('skills.nav'),
              locale: MANAGE_NS,
              inject: injected,
            },
            SkillsSection,
          ),
      )
      ctx.slots.inject(
        'settings.section',
        () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'mcp',
              order: 40,
              label: () => t('mcp.nav'),
              locale: MANAGE_NS,
              inject: injected,
            },
            McpSection,
          ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
