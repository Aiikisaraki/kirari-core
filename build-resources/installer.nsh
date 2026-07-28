# ============================================================================
# 安装向导自定义「模型配置」页（electron-builder nsis.include）
#
# 通过 electron-builder 预留的 customPageAfterChangeDir 宏钩子，
# 把本页插入到「选择安装目录」之后、「开始安装」之前。
#
# 行为：
#   - 若 $APPDATA\akisaki-kirari\config.json 已存在 → 自动跳过本页（升级/重装）
#   - 若不存在 → 显示本页，用户填写 Endpoint / Model / Key 后点「安装」直接开始安装
#     （MUI2 最后一个预安装页的「下一步」按钮自动显示为「安装」）
#
# 收集值写入 $APPDATA\akisaki-kirari\config.json，
# 主程序首次启动读取该文件并注入后端；勾选跳过则不写文件。
# ============================================================================
!include "LogicLib.nsh"
!include "nsDialogs.nsh"

# electron-builder 预留钩子：在"选择安装目录"页之后插入自定义页
!macro customPageAfterChangeDir
  Page custom ModelConfigShow ModelConfigLeave
!macroend

# 仅在「安装构建」中编译本页函数与变量；卸载构建不引用它们，
# 否则 warning 6001/6010（变量/函数未被引用）会导致构建失败。
!ifndef BUILD_UNINSTALLER
Var ModelCfgDialog
Var ModelCfgEndpointBox
Var ModelCfgModelBox
Var ModelCfgKeyBox
Var ModelCfgSkipBox
Var ModelCfgEndpointVal
Var ModelCfgModelVal
Var ModelCfgKeyVal
Var ModelCfgSkipVal

Function ModelConfigShow
  ; ══════════════════════════════════════════════════════════════════
  ; 升级 / 重装检测：已有配置文件则完全跳过本页
  ; 用户将直接从「选择安装目录」进入「安装」确认，体验更流畅
  ; ══════════════════════════════════════════════════════════════════
  ${If} ${FileExists} "$APPDATA\akisaki-kirari\config.json"
    Abort
  ${EndIf}

  nsDialogs::Create 1018
  Pop $ModelCfgDialog
  ${If} $ModelCfgDialog == error
    Abort
  ${EndIf}

  ; ── 标题 ──────────────────────────────────────────────────────
  ${NSD_CreateLabel} 0 0      100% 16u "模型配置"

  ${NSD_CreateLabel} 0 18u    100% 20u "配置大模型连接信息，留空可稍后在程序「设置」中填写。"

  ; ── API Endpoint（标签与输入框同行，节省垂直空间） ────────
  ${NSD_CreateLabel}   0 44u   75u 12u "API Endpoint："
  ${NSD_CreateText}    78u 42u  100% 14u "https://api.chatanywhere.tech/v1"
  Pop $ModelCfgEndpointBox

  ; ── 模型名称 ─────────────────────────────────────────────────
  ${NSD_CreateLabel}   0 64u   75u 12u "模型名称："
  ${NSD_CreateText}    78u 62u  100% 14u "gpt-5.4-mini"
  Pop $ModelCfgModelBox

  ; ── API Key ───────────────────────────────────────────────────
  ${NSD_CreateLabel}   0 84u   75u 12u "API Key："
  ${NSD_CreatePassword}78u 82u  100% 14u ""
  Pop $ModelCfgKeyBox

  ; ── 跳过勾选框（确保在可见区域内） ─────────────────────────
  ${NSD_CreateCheckBox} 0 106u  100% 12u "跳过，稍后再配置"
  Pop $ModelCfgSkipBox

  nsDialogs::Show
FunctionEnd

Function ModelConfigLeave
  ${NSD_GetText} $ModelCfgEndpointBox $ModelCfgEndpointVal
  ${NSD_GetText} $ModelCfgModelBox $ModelCfgModelVal
  ${NSD_GetText} $ModelCfgKeyBox $ModelCfgKeyVal
  ${NSD_GetState} $ModelCfgSkipBox $ModelCfgSkipVal

  ; 勾选"跳过"则不写入任何配置
  ${If} $ModelCfgSkipVal == 1
    Return
  ${EndIf}

  ; 写入 $APPDATA\akisaki-kirari\config.json（与 Electron userData 目录一致）
  CreateDirectory "$APPDATA\akisaki-kirari"
  FileOpen $R0 "$APPDATA\akisaki-kirari\config.json" w
  FileWrite $R0 "{$\"endpoint$\":$\"$ModelCfgEndpointVal$\",$\"model$\":$\"$ModelCfgModelVal$\",$\"key$\":$\"$ModelCfgKeyVal$\"}"
  FileClose $R0
FunctionEnd
!endif
