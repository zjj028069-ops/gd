/* SEDRIC_DEMO_UI=unified-sidebar-inline
 * 侧栏：一级 .kgd-sidebar-primary 内联展开 .kgd-sidebar-children（无浮层二级）。
 * UI 变更时请同步改本文件步骤 find/label，并 bump 下方 DEMO_UI_REV。
 */
var DEMO_UI_REV = "2026-10-21-ext-guide-open-add";
/**
 * 赛德瑞科 · 全手册实时演示剧本（与 knowledge topic.id 对齐）
 * 主路径：iframe 内 live find + 真点击；mesPath 来自 apps/web/src/kgd/menu.ts
 * 写库安全：确定/保存/删除/审核等默认 click:false
 */
(function (global) {
  "use strict";

  /** @type {Record<string, { title: string, steps: Array<object> }>} */
  var DEMOS = {

    /** 列表加扩展字段：工具栏「扩展字段」→ 管理弹窗「新增」→ 用户自填（mesPath 可由 play 注入） */
    "ext-field-add": {
      title: "列表新增扩展字段",
      steps: [
        {
          find: {
            text: "扩展字段",
            css:
              ".kgd-toolbar button,.kgd-toolbar .ant-btn,.kgd-main .kgd-toolbar button," +
              ".ant-pro-table-list-toolbar button,button.ant-btn"
          },
          label: "点工具栏「扩展字段」",
          ops: ["扩展字段"],
          waitMs: 1400,
          findWaitMs: 12000,
          readyWaitMs: 18000,
          hint: "打开该列表的扩展字段管理"
        },
        {
          find: {
            text: "新增",
            css:
              ".ant-modal-wrap button.ant-btn-primary,.ant-modal-wrap .ant-btn," +
              ".ant-modal button.ant-btn-primary,.ant-modal button,.ant-drawer button.ant-btn-primary,.ant-drawer button"
          },
          label: "点弹窗里的「新增」",
          ops: ["新增"],
          waitMs: 1200,
          findWaitMs: 10000,
          hint: "打开「新增扩展字段」；若未找到请手动点「新增」"
        },
        {
          find: {
            text: "字段名",
            css:
              ".ant-modal-wrap label,.ant-modal-wrap .ant-form-item-label," +
              ".ant-drawer label,.ant-drawer .ant-form-item-label"
          },
          label: "在弹窗填写字段名等并确定",
          ops: ["字段名"],
          click: false,
          waitMs: 700,
          findWaitMs: 8000,
          hint: "请自行填写字段名/类型等后点确定；聊天不再代填、不写库"
        }
      ]
    },

    login: {
      title: "怎么登录",
      steps: [
        {
          mesPath: "/app/staging/area",
          find: { rail: "工作台" },
          label: "登录后左侧「工作台」",
          ops: ["工作台"],
          waitMs: 600,
          hint: "若看到登录页，请先在 MES 内登录再演示"
        },
        {
          find: { sub: "工作台" },
          label: "二级「工作台」首页",
          ops: ["工作台"],
          waitMs: 500
        },
        {
          find: { css: ".kgd-top, .kgd-avatar, .ant-avatar, header" },
          label: "右上角区域可退出/个人中心",
          ops: ["退出登录"],
          click: false,
          waitMs: 500,
          hint: "演示只指一下头像区，不自动退出"
        }
      ]
    },

    "ui-layout": {
      title: "认识界面（四大区）",
      steps: [
        {
          mesPath: "/app/staging/area",
          find: { rail: "工作台" },
          label: "① 一级菜单（窄条）",
          ops: ["一级菜单"],
          waitMs: 500
        },
        {
          find: { css: ".kgd-sub" },
          label: "② 侧栏内联二级菜单",
          ops: ["侧栏二级"],
          click: false,
          waitMs: 500,
          hint: "绿色高亮为当前项"
        },
        {
          find: { css: ".kgd-top, .kgd-breadcrumb, header.kgd-top" },
          label: "③ 顶部：面包屑与工具",
          ops: [],
          click: false,
          waitMs: 500
        },
        {
          find: { css: ".kgd-main, main, .kgd-content, #root .kgd-body" },
          label: "④ 中间工作区",
          ops: [],
          click: false,
          waitMs: 500
        }
      ]
    },

    "list-page": {
      title: "列表页怎么用",
      steps: [
        {
          mesPath: "/app/work_repoty_record/list",
          find: { rail: "生产管理" },
          label: "先进入「生产管理」",
          ops: ["生产管理"],
          waitMs: 600
        },
        {
          find: { sub: "报工记录" },
          label: "打开「报工记录」列表作示例",
          ops: ["报工记录"],
          waitMs: 800
        },
        {
          find: { text: "查询", css: "button,.ant-btn" },
          label: "查询区：填条件后点「查询」",
          ops: ["查询"],
          waitMs: 600
        },
        {
          find: { text: "批量操作", css: "button,.ant-btn" },
          label: "先勾选行，再点「批量操作」",
          ops: ["批量操作"],
          click: false,
          waitMs: 500,
          hint: "未勾选时可能是灰色；演示不强制勾选"
        }
      ]
    },

    onboard: {
      title: "开户准备",
      steps: [
        {
          mesPath: "/app/setting/enterprise/setting",
          find: { rail: "系统管理" },
          label: "左侧「系统管理」",
          ops: ["系统管理"],
          waitMs: 600
        },
        {
          find: { sub: "企业信息设置" },
          label: "打开「企业信息设置」",
          ops: ["企业信息设置"],
          waitMs: 800
        },
        {
          mesPath: "/app/role/list",
          find: { sub: "角色管理" },
          label: "角色管理 → 准备「新增」",
          ops: ["角色管理"],
          waitMs: 700
        },
        {
          find: { text: "新增", css: "button,.ant-btn" },
          label: "点「新增」打开角色弹窗",
          ops: ["新增"],
          waitMs: 700,
          hint: "可打开弹窗查看；确定类按钮不会自动点"
        },
        {
          find: { text: "确定", css: "button,.ant-btn" },
          label: "「确定」请自行确认后保存",
          ops: ["确定"],
          click: false,
          waitMs: 500,
          hint: "演示不自动提交，避免写脏库"
        }
      ]
    },

    "goods-create": {
      title: "怎么新增商品",
      steps: [
        {
          mesPath: "/app/goods/list",
          find: { rail: "商品管理" },
          label: "左侧点「商品管理」",
          ops: ["商品管理"],
          waitMs: 600
        },
        {
          find: { sub: "商品列表" },
          label: "点「商品列表」",
          ops: ["商品列表"],
          waitMs: 800
        },
        {
          find: { text: "新增", css: "button,.ant-btn" },
          label: "点绿色「新增」",
          ops: ["+ 新增"],
          waitMs: 800
        },
        {
          find: {
            text: "商品名",
            css: "label,.ant-form-item-label,input,.ant-input"
          },
          label: "指到「商品名」输入区（唯一必填）",
          ops: ["* 商品名"],
          click: false,
          waitMs: 600,
          hint: "演示不自动填表，避免污染数据"
        },
        {
          find: { text: "确定", css: "button,.ant-btn" },
          label: "「确定」请自行确认后保存",
          ops: ["确定"],
          click: false,
          waitMs: 500,
          hint: "演示不自动点确定"
        }
      ]
    },

    "craft-process": {
      title: "录入工艺（工序）",
      steps: [
        {
          mesPath: "/app/public_craft/list",
          find: { rail: "生产管理" },
          label: "左侧「生产管理」",
          ops: ["生产管理"],
          click: false,
          waitMs: 700,
          hint: "已打开工序页；只高亮一级，不点文案（避免跳到项目管理）"
        },
        {
          find: { rail: "生产管理", sub: "工序管理" },
          label: "侧栏展开后点「工序管理」",
          ops: ["工序管理"],
          waitMs: 1100,
          findWaitMs: 8000,
          hint: "先展开三角再点子项；统一侧栏内联二级"
        },
        {
          find: {
            text: "新增",
            css: ".kgd-toolbar button,.kgd-toolbar .ant-btn,.kgd-card button.ant-btn-primary,.kgd-main button.ant-btn,.kgd-main .ant-btn,button.ant-btn-primary"
          },
          label: "点「新增」打开工序弹窗",
          ops: ["新增"],
          waitMs: 1200,
          findWaitMs: 8000
        },
        {
          find: {
            text: "工序",
            css: ".ant-modal-wrap label,.ant-modal-wrap .ant-form-item-label,.ant-drawer label,.ant-drawer .ant-form-item-label"
          },
          label: "指到「工序名」等表单项",
          ops: ["工序名"],
          click: false,
          waitMs: 600,
          findWaitMs: 6000,
          hint: "可自行填写；演示不自动输入"
        },
        {
          find: {
            text: "确定",
            css: ".ant-modal-wrap button,.ant-modal-wrap .ant-btn,.ant-drawer button,.ant-drawer .ant-btn"
          },
          label: "「确定」请自行确认后保存",
          ops: ["确定"],
          click: false,
          waitMs: 500,
          findWaitMs: 5000
        }
      ]
    },

    "craft-route": {
      title: "工艺路线",
      steps: [
        {
          mesPath: "/app/process_routing/list",
          find: { rail: "生产管理" },
          label: "左侧「生产管理」",
          ops: ["生产管理"],
          click: false,
          waitMs: 700,
          hint: "只高亮一级，不点文案（避免跳到项目管理）"
        },
        {
          find: { rail: "生产管理", sub: "工艺路线" },
          label: "侧栏展开后点「工艺路线」",
          ops: ["工艺路线"],
          waitMs: 800
        },
        {
          find: { text: "新增", css: "button,.ant-btn" },
          label: "点「新增」创建路线",
          ops: ["新增"],
          waitMs: 800
        },
        {
          find: { text: "保存", css: "button,.ant-btn" },
          label: "「保存」请自行确认后提交",
          ops: ["保存"],
          click: false,
          waitMs: 500,
          hint: "起名 → 按顺序选工序 → 自行保存；开加工单时可从工艺路线整串添加"
        },
        {
          mesPath: "/app/bom/list",
          find: { rail: "商品管理" },
          label: "（可选）商品管理 → BOM",
          ops: ["商品管理"],
          waitMs: 600
        },
        {
          find: { sub: "BOM管理" },
          label: "打开「BOM管理」",
          ops: ["BOM管理"],
          waitMs: 700
        }
      ]
    },

    contract: {
      title: "客户与合同订单",
      steps: [
        {
          mesPath: "/app/customer/list",
          find: { rail: "客户管理" },
          label: "左侧「客户管理」",
          ops: ["客户管理"],
          waitMs: 600
        },
        {
          find: { sub: "客户管理" },
          label: "二级「客户管理」列表",
          ops: ["客户管理"],
          waitMs: 700
        },
        {
          find: { text: "新增", css: "button,.ant-btn" },
          label: "点「新增」录客户",
          ops: ["新增"],
          waitMs: 700
        },
        {
          find: { text: "确定", css: "button,.ant-btn" },
          label: "客户「确定」请自行保存",
          ops: ["确定"],
          click: false,
          waitMs: 400
        },
        {
          mesPath: "/app/customer_contract/list",
          find: { sub: "合同订单" },
          label: "打开「合同订单」",
          ops: ["合同订单"],
          waitMs: 800
        },
        {
          find: { text: "新增", css: "button,.ant-btn" },
          label: "合同订单「+ 新增」",
          ops: ["+ 新增"],
          waitMs: 700
        },
        {
          find: { text: "保存", css: "button,.ant-btn" },
          label: "「保存」请自行确认后提交",
          ops: ["保存"],
          click: false,
          waitMs: 500
        }
      ]
    },

    purchase: {
      title: "采购与供应商",
      steps: [
        {
          mesPath: "/app/supplier/list",
          find: { rail: "供应/采购" },
          label: "左侧「供应/采购」",
          ops: ["供应/采购"],
          waitMs: 600
        },
        {
          find: { sub: "供应商管理" },
          label: "打开「供应商管理」",
          ops: ["供应商管理"],
          waitMs: 700
        },
        {
          find: { text: "新增", css: "button,.ant-btn" },
          label: "点「新增」供应商",
          ops: ["新增"],
          waitMs: 700
        },
        {
          find: { text: "确定", css: "button,.ant-btn" },
          label: "「确定」请自行保存",
          ops: ["确定"],
          click: false,
          waitMs: 400
        },
        {
          mesPath: "/app/purchase_order/list",
          find: { sub: "采购单" },
          label: "打开「采购单」",
          ops: ["采购单"],
          waitMs: 800
        },
        {
          find: { text: "新增", css: "button,.ant-btn" },
          label: "点「新增」采购单",
          ops: ["+ 新增"],
          waitMs: 700
        },
        {
          find: { text: "保存", css: "button,.ant-btn" },
          label: "「保存」请自行确认",
          ops: ["保存"],
          click: false,
          waitMs: 500
        }
      ]
    },

    warehouse: {
      title: "仓库出入库与库存",
      steps: [
        {
          mesPath: "/app/ware/list",
          find: { rail: "仓库管理" },
          label: "左侧「仓库管理」",
          ops: ["仓库管理"],
          waitMs: 600
        },
        {
          find: { sub: "仓库管理" },
          label: "二级「仓库管理」",
          ops: ["仓库管理"],
          waitMs: 700
        },
        {
          mesPath: "/app/goods_stock/list",
          find: { sub: "库存管理" },
          label: "打开「库存管理」看结存",
          ops: ["库存管理"],
          waitMs: 800
        },
        {
          find: { text: "查询", css: "button,.ant-btn" },
          label: "查询商品看当前库存",
          ops: ["查询"],
          waitMs: 600
        },
        {
          mesPath: "/app/purchase_order/list",
          find: { rail: "供应/采购" },
          label: "采购单行上可「入库」",
          ops: ["采购单"],
          waitMs: 700
        },
        {
          find: { text: "入库", css: "button,.ant-btn,a" },
          label: "指到「入库」（有权限且有待入单时）",
          ops: ["入库"],
          click: false,
          waitMs: 500,
          hint: "入库会改库存，演示只指一下不自动点"
        }
      ]
    },

    "work-order": {
      title: "怎么开加工单",
      steps: [
        {
          mesPath: "/app/inside_produce_bill/list",
          find: { rail: "生产管理" },
          label: "左侧「生产管理」",
          ops: ["生产管理"],
          waitMs: 600
        },
        {
          find: { sub: "加工单" },
          label: "打开「加工单」",
          ops: ["加工单"],
          waitMs: 800
        },
        {
          find: { text: "新增", css: "button,.ant-btn" },
          label: "点「新增」",
          ops: ["+ 新增"],
          waitMs: 700
        },
        {
          find: { text: "直接创建", css: "button,.ant-btn,.ant-dropdown-menu-item,li" },
          label: "可选「直接创建」或「合同创建」",
          ops: ["直接创建"],
          waitMs: 700,
          hint: "若已是下拉项则点击；找不到可手动下一步"
        },
        {
          find: { text: "保存", css: "button,.ant-btn" },
          label: "填商品与数量后，「保存」请自行确认",
          ops: ["保存"],
          click: false,
          waitMs: 500
        }
      ]
    },

    "report-work": {
      title: "怎么报工",
      steps: [
        {
          mesPath: "/app/inside_produce_bill/list",
          find: { rail: "生产管理" },
          label: "生产管理 → 加工单",
          ops: ["生产管理"],
          waitMs: 600
        },
        {
          find: { sub: "加工单" },
          label: "打开加工单列表",
          ops: ["加工单"],
          waitMs: 800
        },
        {
          find: { text: "报工", css: "button,.ant-btn,a" },
          label: "在列表/详情工序行点「报工」",
          ops: ["报工"],
          waitMs: 800,
          hint: "若列表无报工按钮，请先点开某张加工单详情"
        },
        {
          find: { text: "确定", css: "button,.ant-btn" },
          label: "报工「确定」请自行确认后提交",
          ops: ["确定"],
          click: false,
          waitMs: 500,
          hint: "选生产人员、填良品数后自行确定；演示不自动提交"
        },
        {
          mesPath: "/app/work_repoty_record/list",
          find: { sub: "报工记录" },
          label: "也可在「报工记录」查看",
          ops: ["报工记录"],
          waitMs: 700
        }
      ]
    },

    wage: {
      title: "问工资",
      steps: [
        {
          mesPath: "/app/work_repoty_record/list",
          find: { rail: "生产管理" },
          label: "生产管理 → 报工记录",
          ops: ["生产管理"],
          waitMs: 600
        },
        {
          find: { sub: "报工记录" },
          label: "打开「报工记录」",
          ops: ["报工记录"],
          waitMs: 800
        },
        {
          find: { text: "结算", css: "button,.ant-btn,a" },
          label: "行上「结算」（改结算状态）",
          ops: ["结算"],
          click: false,
          waitMs: 500,
          hint: "结算会影响工资状态，演示不自动点"
        },
        {
          mesPath: "/app/payroll_statement/list",
          find: { rail: "报表中心" },
          label: "报表中心 → 生产工资报表",
          ops: ["报表中心"],
          waitMs: 700
        },
        {
          find: { sub: "生产工资报表" },
          label: "打开「生产工资报表」按人汇总",
          ops: ["生产工资报表"],
          waitMs: 800
        }
      ]
    },

    money: {
      title: "问钱（欠款/收款）",
      steps: [
        {
          mesPath: "/app/customer_contract/list",
          find: { rail: "客户管理" },
          label: "客户管理 → 合同订单",
          ops: ["客户管理"],
          waitMs: 600
        },
        {
          find: { sub: "合同订单" },
          label: "打开合同订单看【欠款】",
          ops: ["合同订单"],
          waitMs: 800
        },
        {
          find: { text: "收款", css: "button,.ant-btn,a" },
          label: "某张合同点「收款」",
          ops: ["收款"],
          click: false,
          waitMs: 500,
          hint: "收款写流水，演示只指一下"
        },
        {
          mesPath: "/app/customer_financier/list",
          find: { sub: "收支记录" },
          label: "「收支记录」看流水",
          ops: ["收支记录"],
          waitMs: 700
        }
      ]
    },

    progress: {
      title: "问进度",
      steps: [
        {
          mesPath: "/app/inside_produce_bill/list",
          find: { rail: "生产管理" },
          label: "加工单详情看各工序进度",
          ops: ["生产管理"],
          waitMs: 600
        },
        {
          find: { sub: "加工单" },
          label: "打开「加工单」",
          ops: ["加工单"],
          waitMs: 700
        },
        {
          find: { sub: "生产任务" },
          label: "「生产任务」看全厂任务",
          ops: ["生产任务"],
          waitMs: 700
        },
        {
          mesPath: "/app/ProductionScheduling/list",
          find: { sub: "生产排产" },
          label: "「生产排产」甘特看排期",
          ops: ["生产排产"],
          waitMs: 700
        },
        {
          mesPath: "/app/ProductionPlan/list",
          find: { sub: "生产计划MRP" },
          label: "需要时看「生产计划MRP」",
          ops: ["生产计划MRP"],
          waitMs: 700
        },
        {
          mesPath: "/app/screen_management/list",
          find: { rail: "数据大屏" },
          label: "「数据大屏」看全厂态势",
          ops: ["数据大屏"],
          waitMs: 700
        }
      ]
    },

    "roles-daily": {
      title: "分角色每天做什么",
      steps: [
        {
          mesPath: "/app/staging/area",
          find: { rail: "工作台" },
          label: "老板：工作台待办",
          ops: ["工作台"],
          waitMs: 600
        },
        {
          mesPath: "/app/customer_contract/list",
          find: { rail: "客户管理" },
          label: "文员：客户合同与开票",
          ops: ["合同订单"],
          waitMs: 700
        },
        {
          mesPath: "/app/goods_stock/list",
          find: { rail: "仓库管理" },
          label: "仓管：入库出库与库存",
          ops: ["库存管理"],
          waitMs: 700
        },
        {
          mesPath: "/app/work_repoty_record/list",
          find: { rail: "生产管理" },
          label: "工人：每天报工（报工记录）",
          ops: ["报工"],
          waitMs: 700
        }
      ]
    },

    faq: {
      title: "常见问题 FAQ",
      steps: [
        {
          mesPath: "/app/staging/area",
          find: { rail: "工作台" },
          label: "菜单看不到？先认一级菜单，再找管理员开权限",
          ops: [],
          waitMs: 600
        },
        {
          mesPath: "/app/work_repoty_record/list",
          find: { text: "批量操作", css: "button,.ant-btn" },
          label: "批量操作灰色：先勾选表格左边至少一行",
          ops: ["批量操作"],
          click: false,
          waitMs: 500
        },
        {
          mesPath: "/app/account",
          find: { rail: "系统管理" },
          label: "改密码：系统管理 → 个人中心",
          ops: ["个人中心"],
          waitMs: 700
        },
        {
          find: { sub: "个人中心" },
          label: "打开「个人中心」改密码",
          ops: ["个人中心", "修改密码"],
          waitMs: 700,
          hint: "演示不自动改密码"
        },
        {
          mesPath: "/app/setting/enterprise/setting",
          find: { sub: "企业信息设置" },
          label: "模块关了？企业信息设置里看功能开关",
          ops: ["企业信息设置"],
          waitMs: 700
        }
      ]
    }
  };

  function getDemo(id) {
    return DEMOS[id] || null;
  }

  function listDemoIds() {
    return Object.keys(DEMOS);
  }

  global.SedricDemos = {
    VERSION: "live-mes-demo-r1",
    demos: DEMOS,
    getDemo: getDemo,
    listDemoIds: listDemoIds
  };
})(typeof window !== "undefined" ? window : globalThis);
