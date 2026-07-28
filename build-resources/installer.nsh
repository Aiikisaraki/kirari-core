# ============================================================================
# 安装向导自定义「模型配置」页（electron-builder nsis.include）
#
# 通过 electron-builder 预留的 customPageAfterChangeDir 宏钩子，
# 把本页插入到「选择安装目录」之后、「开始安装」之前。
#
# 收集：API Endpoint / 模型名称 / API Key（可选，可勾选跳过）。
# 安装时把值写入 $APPDATA\akisaki-kirari\config.json，
# 主程序首次启动读取该文件并注入后端；跳过则不写文件。
#
# 注意：本文件被 !include 在 MUI 页面之前，因此必须自行引入 LogicLib/nsDialogs，
# 且不能使用 MUI_HEADER_TEXT（它在后面才定义）。页面标题用 nsDialogs 标签呈现。
# ============================================================================
!include "LogicLib.nsh"
!include "nsDialogs.nsh"

# electron-builder 预留钩子：在"选择安装目录"页之后插入自定义页
!macro customPageAfterChangeDir
  Page custom ModelConfigShow ModelConfigLeave
!macroend

# 仅在「安装构建」中编译本页函数与变量；卸载构建（BUILD_UNINSTALLER 已定义）不引用它们，
# 若仍编译会因 warning 6001/6010（变量/函数未被引用）被 electron-builder 当作 error 而失败。
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
Var ModelCfgSubtitle

Function ModelConfigShow
  nsDialogs::Create 1018
  Pop $ModelCfgDialog
  ${If} $ModelCfgDialog == error
    Abort
  ${EndIf}

  # 升级场景检测：若已存在配置文件，则默认保留（不覆盖），仅提示用户
  ${If} ${FileExists} "$APPDATA\akisaki-kirari\config.json"
    StrCpy $ModelCfgSubtitle "检测到已存在配置文件（$APPDATA\akisaki-kirari\config.json），默认保留现有设置、不覆盖。取消勾选「跳过」可手动修改。"
  ${Else}
    StrCpy $ModelCfgSubtitle "配置大模型端点、模型名称与 API Key；留空可稍后在程序「设置」中配置。"
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 12u "模型配置（可选）"
  ${NSD_CreateLabel} 0 12u 100% 24u "$ModelCfgSubtitle"

  ${NSD_CreateLabel} 0 40u 100% 12u "API Endpoint（默认 https://api.chatanywhere.tech/v1）："
  ${NSD_CreateText} 0 53u 100% 12u "https://api.chatanywhere.tech/v1"
  Pop $ModelCfgEndpointBox

  ${NSD_CreateLabel} 0 72u 100% 12u "模型名称（如 gpt-5.4-mini / gpt-5-nano）："
  ${NSD_CreateText} 0 85u 100% 12u "gpt-5.4-mini"
  Pop $ModelCfgModelBox

  ${NSD_CreateLabel} 0 104u 100% 12u "API Key："
  ${NSD_CreatePassword} 0 117u 100% 12u ""
  Pop $ModelCfgKeyBox

  ${NSD_CreateCheckBox} 0 138u 100% 12u "跳过，稍后在程序「设置」中配置"
  Pop $ModelCfgSkipBox
  # 升级时默认勾选“跳过”，避免覆盖用户已有的配置
  ${If} ${FileExists} "$APPDATA\akisaki-kirari\config.json"
    ${NSD_Check} $ModelCfgSkipBox
  ${EndIf}

  nsDialogs::Show
FunctionEnd

Function ModelConfigLeave
  ${NSD_GetText} $ModelCfgEndpointBox $ModelCfgEndpointVal
  ${NSD_GetText} $ModelCfgModelBox $ModelCfgModelVal
  ${NSD_GetText} $ModelCfgKeyBox $ModelCfgKeyVal
  ${NSD_GetState} $ModelCfgSkipBox $ModelCfgSkipVal

  # 勾选"跳过"则不写入任何配置
  ${If} $ModelCfgSkipVal == 1
    Return
  ${EndIf}

  # 写入 $APPDATA\akisaki-kirari\config.json（与 Electron userData 目录一致）
  CreateDirectory "$APPDATA\akisaki-kirari"
  FileOpen $R0 "$APPDATA\akisaki-kirari\config.json" w
  FileWrite $R0 "{$\"endpoint$\":$\"$ModelCfgEndpointVal$\",$\"model$\":$\"$ModelCfgModelVal$\",$\"key$\":$\"$ModelCfgKeyVal$\"}"
  FileClose $R0
FunctionEnd
!endif
