/*
 * @Author: Aii如樱如月 morikawa@kimisui56.work
 * @Date: 2026-07-05 23:52:41
 * @LastEditors: Aii如樱如月 morikawa@kimisui56.work
 * @LastEditTime: 2026-07-07 23:48:46
 * @FilePath: \pet-api\src\token\apiTokenManager.js
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
const dbStorage = require('../db/dbStorage');

class ApiTokenManager {
    constructor() {
        this.storage = dbStorage;
    }

    async getApiToken(userid) {
        return await this.storage.getApiToken(userid);
    }

    async setApiToken(userid, token, viewPassword, clientId, model, apiEndpoint) {
        await this.storage.setApiToken(userid, token, viewPassword, clientId, model, apiEndpoint);
    }

    async getModelConfig(userid) {
        return await this.storage.getModelConfig(userid);
    }

    async setModelConfig(userid, model) {
        return await this.storage.setModelConfig(userid, model);
    }

    async setApiEndpoint(userid, apiEndpoint) {
        return await this.storage.setApiEndpoint(userid, apiEndpoint);
    }

    async verifyViewPassword(userid, viewPassword) {
        return await this.storage.verifyViewPassword(userid, viewPassword);
    }
}

module.exports = new ApiTokenManager();