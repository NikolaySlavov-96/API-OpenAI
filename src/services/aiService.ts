import { Request } from 'express';

import { openAI, anthropicAI } from '../providersServices';

import { IMessageType, IQueryParser, ISendRequestConfig, TProviders } from '../types';

import db from '../models';
import { IMessageAttributes, IPromptMessageAttributes, IUserPromptAttributes, IPromptAttributes } from '../models/models.interface';
import { pageParser } from '../helpers';

const PROVIDERS: TProviders = {
    'anthropic': anthropicAI,
    'openAI': openAI,
};

const PROMPT_ROLE = {
    ASSISTANT: 'assistant',
    SYSTEM: 'system',
    USER: 'user',
};

interface IMessageResponse extends IPromptMessageAttributes {
    Message: IMessageAttributes;
}
const getPromptMessages = async (promptId: string, query?: IQueryParser) => {
    const { ordering, offset, limit } = pageParser(query);

    const result: IMessageResponse[] = await db.PromptMessage.findAll({
        where: { promptId },
        include: [
            {
                model: db.Message,
                // attributes: ['id'],
                require: false,
            }
        ],
        order: [['id', ordering]],
        offset,
        limit,
        raw: true,
        nest: true,
    });
    return result;
}


export const sendAiRequestToProvider = async (data: ISendRequestConfig, body: Request['body']) => {
    try {
        const { message: content, promptId } = body;

        const promptsByPromptId = await getPromptMessages(promptId, { limit: '2' });

        const userOldMessages = promptsByPromptId.map((mss) => {
            return {
                content: mss?.Message?.content,
                role: mss?.Message?.role
            }
        })

        const userMessageFormat: IMessageType = { role: "user", content };
        userOldMessages.push(userMessageFormat);

        // Request to OpenAI provider (OpenAI, Anthropic)
        const result = await PROVIDERS[data.provider](data, userOldMessages);

        // Save userMessage into DB
        const userMessageDBResult = await db.Message.create({ ...userMessageFormat, tokenCost: result.inputToken })
        const messageIdUser = userMessageDBResult.dataValues.id;
        await db.PromptMessage.create({ promptId, messageId: messageIdUser });

        // Save BotResponse into DB
        const botMessageResultDBResponse = await db.Message.create({ role: result.role, content: result.content, tokenCost: result.outputToken })
        const messageIdBotResponse = botMessageResultDBResponse.dataValues.id;
        await db.PromptMessage.create({ promptId, messageId: messageIdBotResponse });

        // Update promptCosts
        const promptCostRecordResult = await db.PromptCost.findOne({ where: { promptId } });
        await promptCostRecordResult.increment({
            totalInputCost: Number(result.inputToken),
            totalOutputCost: Number(result.outputToken)
        })

        return { content: result.content };
    } catch (error) {
        console.log("🚀 ~ sendAiRequestToProvider ~ error:", error)
    }
};

export const createPrompt = async (aiConfig: ISendRequestConfig, promptName: string, userId: string) => {
    // Create Prompt
    const createPromptResult = await db.Prompt.create({ name: promptName, promptModel: aiConfig.model });
    const promptId = createPromptResult.dataValues.id;

    // Create record in PromptCost table
    await db.PromptCost.create({ promptId, totalInputCost: 0, totalOutputCost: 0 });

    await db.UserPrompt.create({ userId: userId, promptId });

    return { status: 200, promptData: { promptId } };
};

interface IAllPrompts extends IUserPromptAttributes {
    Prompt: IPromptAttributes;
}
export const getAllPrompts = async (userId: string) => {
    const result: IAllPrompts[] = await db.UserPrompt.findAll({
        where: { userId },
        include: [
            {
                model: db.Prompt,
                attributes: ['id', 'name'],
                require: false,
                where: { isDeleted: false, isVisible: true }
            }
        ],
        raw: true,
        nest: true,
    });

    const filterResult = result.map(pr => pr.Prompt);
    return filterResult;
};

export const verifyPromptExist = async (promptId: string) => {
    const promptData = await db.Prompt.findOne({
        where: { id: promptId, isDeleted: false },
        raw: true,
        nest: true,
    });
    return promptData;
};

export const verifyOwnerOnPrompt = async (promptId: string, userId: string) => {
    const result = await db.UserPrompt.findOne({
        where: { promptId, userId },
        raw: true,
        nest: true,
    });
    return result;
}

export const getAllMessagesByPromptId = async (promptId: string, query?: IQueryParser) => {
    const result = await getPromptMessages(promptId, query);

    const mappedMessages = result.map(mss => {
        return {
            content: mss.Message.content,
            id: mss.Message.id
        }
    });

    return mappedMessages;
};