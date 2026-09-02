// src/services/fallbackService.js
const fs = require("fs");
const path = require("path");

const responseCategories = [
    { name: "greeting", keywords: ["你好", "hello", "hi", "在吗", "嗨"] },
    { name: "goodbye", keywords: ["再见", "拜拜", "88", "走了", "晚安"] },
    { name: "praise", keywords: ["真棒", "聪明", "可爱", "好乖", "喜欢你"] },
    { name: "scold", keywords: ["笨", "傻", "讨厌", "烦", "闭嘴"] },
    {
        name: "status",
        keywords: ["你是谁", "你能做什么", "有什么功能", "你会什么"],
    },
    { name: "time", keywords: ["几点", "时间", "现在"] },
    { name: "weather", keywords: ["天气", "下雨", "冷吗", "热吗"] },
];

let responseList = null;

function loadResponseList() {
    const filePath = path.resolve(
        __dirname,
        "../../res/fallback_responses.json",
    );
    try {
        const data = fs.readFileSync(filePath, "utf-8");
        responseList = JSON.parse(data);
        return responseList;
    } catch (err) {
        console.error("❌ 读取回答预设文件失败:", err.message);
        return { responses: {} };
    }
}

function getReply({ content = "", persona = null } = {}) {
    if (!responseList) loadResponseList();

    // 1. 匹配分类
    let categoryName = "default";
    for (const category of responseCategories) {
        if (category.keywords.some((k) => content.includes(k))) {
            categoryName = category.name;
            break;
        }
    }

    // 2. 获取随机回复
    const categoryData = responseList.responses[categoryName];
    const replies = categoryData.replies;
    const randomIndex = Math.floor(Math.random() * replies.length);
    let reply = { ...replies[randomIndex] };

    // 3. 格式化动态变量
    if (reply.speech.includes("{{current_time}}")) {
        const now = new Date();
        const timeString = now.toLocaleTimeString("zh-CN", {
            hour: "2-digit",
            minute: "2-digit",
        });
        reply.speech = reply.speech.replace("{{current_time}}", timeString);
    }

    // 4. 按分类附带情绪标签，供前端“情绪优先”动画（happy/wave）使用。
    const categoryEmotion = {
      greeting: 'wave',
      praise: 'happy',
      goodbye: 'wave',
      scold: 'sad',
    };
    reply.emotion = categoryEmotion[categoryName] || null;

    return reply;
}

module.exports = { getReply };
