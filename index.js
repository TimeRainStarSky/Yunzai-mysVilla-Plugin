logger.info(logger.yellow("- 正在加载 米游社大别野 适配器插件"))

import { config, configSave } from "./Model/config.js"
import fetch, { FormData, File } from "node-fetch"
import common from "../../lib/common/common.js"
import imageSize from "image-size"
import bodyParser from "body-parser"
import { createHmac } from "node:crypto"

const adapter = new class mysVillaAdapter {
  constructor() {
    this.id = "mysVilla"
    this.name = "米游社大别野Bot"
    this.fs = {}
  }

  async sendApi(id, action, villa_id, data) {
    const opts = {
      headers: {
        "x-rpc-bot_id": id.replace(/^mv_/, ""),
        "x-rpc-bot_secret": Bot[id].secret_hmac,
        "x-rpc-bot_villa_id": villa_id,
      },
    }

    if (data) {
      opts.method = "POST"
      opts.body = JSON.stringify(data)
    }

    let res
    try {
      res = await fetch(`https://bbs-api.miyoushe.com/vila/api/bot/platform/${action}`, opts)
      res = await res.json()
    } catch (err) {
      logger.error(`请求 API 错误：${logger.red(err)}`)
    }
    return res
  }

  async uploadFS(file) {
    if (!file.match(/^base64:\/\//))
      return { url: file }

    file = Buffer.from(file.replace(/^base64:\/\//, ""), "base64")
    const size = imageSize(file)
    const name = `${Date.now()}.${size.type}`
    this.fs[name] = file
    setTimeout(() => delete this.fs[name], 60000)

    return {
      url: `${config.url}/mysVilla/${name}`,
      size,
      file_size: file.length,
    }
  }

  async uploadImage(data, file) {
    file = await this.uploadFS(file)
    for (let i = 0; i < 5; i++) try {
      const res = await data.bot.sendApi("transferImage", data.villa_id, {
        url: file.url,
      })
      if (res?.data?.new_url) {
        file.url = res.data.new_url
        break
      }
      await common.sleep(3000)
    } catch (err) {
      logger.error(err)
    }
    return file
  }

  async makeMsg(data, msg) {
    if (!Array.isArray(msg))
      msg = [msg]
    let object_name = "MHY:Text"
    let content = {
      text: "",
      entities: [],
      images: [],
    }
    let mentionedInfo
    let quote

    for (let i of msg) {
      if (typeof i != "object")
        i = { type: "text", text: i }

      switch (i.type) {
        case "text":
          content.text += i.text
          break
        case "image":
          content.images.push(await this.uploadImage(data, i.file))
          break
        case "reply": {
          let msg_uid = i.id.split("-")
          const msg_time = Number(msg_uid.shift())
          msg_uid = msg_uid.join("-")
          quote = {
            original_message_id: msg_uid,
            original_message_send_time: msg_time,
            quoted_message_id: msg_uid,
            quoted_message_send_time: msg_time,
          }
          break
        } case "at": {
          const entity = {}
          if (i.qq == "all") {
            mentionedInfo = { type: 1 }
            entity.type = "mention_all"
          } else {
            const user_id = i.qq.replace(/^mv_/, "")
            if (Array.isArray(mentionedInfo?.userIdList)) {
              mentionedInfo.userIdList.push(user_id)
            } else {
              mentionedInfo = { type: 2, userIdList: [user_id] }
            }
            entity.type = "mentioned_user"
            entity.user_id = user_id
          }

          const member = data.bot.pickMember(data.group_id, i.qq)
          const text = `@${member.nickname || (await member.getInfo()).nickname} `
          content.entities.push({
            entity,
            length: text.length,
            offset: content.text.length,
          })
          content.text += text
          break
        } default:
          i = JSON.stringify(i)
          content.text += i
      }
    }

    if (content.images.length == 1) {
      object_name = "MHY:Image"
      content = content.images[0]
    } else if (!content.text) {
      content.text = " "
    }

    return {
      object_name,
      msg_content: JSON.stringify({
        content,
        mentionedInfo,
        quote,
      }),
    }
  }

  async sendMsg(data, msg) {
    if (msg?.type == "node")
      return Bot.sendForwardMsg(msg => this.sendMsg(data, msg), msg.data)

    const { object_name, msg_content } = await this.makeMsg(data, msg)
    logger.info(`${logger.blue(`[${data.self_id}]`)} 发送消息：[${data.villa_id}-${data.room_id}] ${object_name} ${msg_content}`)
    const res = await data.bot.sendApi("sendMessage", data.villa_id, {
      room_id: data.room_id,
      object_name,
      msg_content,
    })
    return {
      data: res,
      message_id: `${Date.now()}-${res?.data?.bot_msg_id}`,
    }
  }

  recallMsg(data, message_id) {
    logger.info(`${logger.blue(`[${data.self_id}]`)} 撤回消息：[${data.villa_id}-${data.room_id}] ${message_id}`)
    let msg_uid = message_id.split("-")
    const msg_time = Number(msg_uid.shift())
    msg_uid = msg_uid.join("-")
    return data.bot.sendApi("recallMessage", data.villa_id, {
      room_id: data.room_id,
      msg_uid,
      msg_time,
    })
  }

  async getMemberInfo(data) {
    const i = (await data.bot.sendApi(`getMember?uid=${data.user_id}`, data.villa_id)).data.member
    return {
      ...i,
      user_id: `mv_${i.basic.uid}`,
      nickname: i.basic.nickname,
      avatar: i.basic.avatar_url,
    }
  }

  async getMemberArray(data) {
    return (await data.bot.sendApi("getVillaMembers", data.villa_id)).data.list
  }

  async getMemberList(data) {
    const array = []
    for (const i of (await this.getMemberArray(data)))
      array.push(i.user_id)
    return array
  }

  async getMemberMap(data) {
    const map = new Map
    for (const i of (await this.getMemberArray(data)))
      map.set(i.user_id, i)
    return map
  }

  pickFriend(id, user_id) {
    const i = {
      ...Bot[id].fl.get(user_id),
      self_id: id,
      bot: Bot[id],
      user_id: user_id.replace(/^mv_/, ""),
    }
    return {
      ...i,
      sendMsg: () => false,
      recallMsg: () => false,
    }
  }

  pickMember(id, group_id, user_id) {
    const guild_id = group_id.replace(/^mv_/, "").split("-")
    const i = {
      ...Bot[id].fl.get(user_id),
      self_id: id,
      bot: Bot[id],
      villa_id: guild_id[0],
      room_id: guild_id[1],
      user_id: user_id.replace(/^mv_/, ""),
    }
    return {
      ...this.pickFriend(id, user_id),
      ...i,
      getInfo: () => this.getMemberInfo(i),
    }
  }

  pickGroup(id, group_id) {
    const guild_id = group_id.replace(/^mv_/, "").split("-")
    const i = {
      ...Bot[id].gl.get(group_id),
      self_id: id,
      bot: Bot[id],
      villa_id: guild_id[0],
      room_id: guild_id[1],
    }
    return {
      ...i,
      sendMsg: msg => this.sendMsg(i, msg),
      recallMsg: message_id => this.recallMsg(i, message_id),
      getMemberArray: () => this.getMemberArray(i),
      getMemberList: () => this.getMemberList(i),
      getMemberMap: () => this.getMemberMap(i),
      pickMember: user_id => this.pickMember(id, group_id, user_id),
    }
  }

  makeMessage(data) {
    data.event = {
      ...data.extend_data.EventData.SendMessage,
      ...JSON.parse(data.extend_data.EventData.SendMessage.content),
    }

    data.post_type = "message"
    data.user_id = `mv_${data.event.from_user_id}`
    data.sender = {
      user_id: data.user_id,
      nickname: data.event.nickname,
      avatar: data.event.user.portrait,
    }
    data.bot.fl.set(data.user_id, { ...data.event.user, ...data.sender })
    data.message_id = `${data.event.send_at}-${data.event.msg_uid}`

    data.message = []
    data.raw_message = ""

    if (data.event.quote?.quoted_message_id) {
      const id = `${data.event.quote.quoted_message_send_time}-${data.event.quote.quoted_message_id}`
      data.message.push({ type: "reply", id })
      data.raw_message += `[回复：${id})]`
    }

    let start = 0
    for (const i of data.event.content.entities) {
      const text = data.event.content.text.slice(start, i.offset)
      if (text) {
        data.message.push({ type: "text", text })
        data.raw_message += text
      }
      start = i.offset + i.length

      switch (i.entity.type) {
        case "mentioned_robot":
          data.message.push({ type: "at", qq: `mv_${i.entity.bot_id}` })
          data.raw_message += `[提及Bot：mv_${i.entity.bot_id}]`
          break
        case "mentioned_user":
          data.message.push({ type: "at", qq: `mv_${i.entity.user_id}` })
          data.raw_message += `[提及：mv_${i.entity.user_id}]`
          break
        case "mention_all":
          data.message.push({ type: "at", qq: "all" })
          data.raw_message += "[提及全体成员]"
          break
        case "villa_room_link":
          data.message.push({ type: "atGroup", id: `mv_${i.entity.villa_id}-${i.entity.room_id}` })
          data.raw_message += `[提及群：mv_${i.entity.villa_id}-${i.entity.room_id}]`
          break
        default:
          data.message.push(i.entity)
          data.raw_message += JSON.stringify(i.entity)
      }
    }

    const text = data.event.content.text.slice(start)
    if (text) {
      data.message.push({ type: "text", text })
      data.raw_message += text
    }

    for (const i of data.event.content.images || []) {
      data.message.push({ type: "image", url: i.url })
      data.raw_message += `[图片：${i.url}]`
    }

    data.message_type = "group"
    data.group_id = `mv_${data.event.villa_id}-${data.event.room_id}`
    data.bot.gl.set(data.group_id, { group_id: data.group_id })
    logger.info(`${logger.blue(`[${data.self_id}]`)} 群消息：[${data.group_name}(${data.group_id}), ${data.sender.nickname}(${data.user_id})] ${data.raw_message}`)

    Bot.em(`${data.post_type}.${data.message_type}`, data)
  }

  makeWebHook(req) {
    logger.mark(`${logger.blue(`[${req.ip} => ${req.url}]`)} HTTP ${req.method} 请求：${JSON.stringify(req.headers)}`)

    const data = req.body.event
    if (!data?.robot?.template?.id)
      return false
    data.self_id = `mv_${data.robot.template.id}`
    data.bot = Bot[data.self_id]
    data.bot.info = data.robot.template

    switch (data.type) {
      case 1:
        break
      case 2:
        this.makeMessage(data)
        break
      case 3:
        break
      case 4:
        break
      case 5:
        break
      case 6:
        break
      default:
        logger.warn(`${logger.blue(`[${data.self_id}]`)} 未知消息：${logger.magenta(JSON.stringify(data))}`)
    }
    req.res.json({ message: "", retcode: 0 })
  }

  async connect(token) {
    token = token.split(":")
    const id = `mv_${token[0]}`
    Bot[id] = {
      adapter: this,
      uin: id,
      secret: token[1],
      pub_key: `${token[2].replace(/ /g, "\n").replace(/\nPUBLIC\n/g, " PUBLIC ")}\n`,
      sendApi: (action, villa_id, data) => this.sendApi(id, action, villa_id, data),

      info: {},
      get nickname() { return this.info.name },
      get avatar() { return this.info.icon },

      version: {
        id: this.id,
        name: this.name,
      },
      stat: { start_time: Date.now() / 1000 },

      pickUser: user_id => this.pickFriend(id, user_id),
      pickFriend: user_id => this.pickFriend(id, user_id),

      pickMember: (group_id, user_id) => this.pickMember(id, group_id, user_id),
      pickGroup: group_id => this.pickGroup(id, group_id),

      fl: new Map,
      gl: new Map,
      gml: new Map,
    }
    Bot[id].secret_hmac = createHmac("sha256", Bot[id].pub_key).update(Bot[id].secret).digest("hex")

    logger.mark(`${logger.blue(`[${id}]`)} ${this.name}(${this.id}) 已连接`)
    Bot.em(`connect.${id}`, { self_id: id })
    return true
  }

  makeFileServer(req) {
    const file = this.fs[req.url.replace(/^\/mysVilla\//, "")]
    if (!file) return req.next()
    logger.mark(`${logger.blue(`[${req.ip} => ${req.url}]`)} HTTP ${req.method} 请求：${JSON.stringify(req.headers)}`)
    req.res.send(file)
  }

  async load() {
    for (const token of config.token)
      await adapter.connect(token)
    Bot.express.post("/mysVilla", bodyParser.json(), req => this.makeWebHook(req))
    Bot.express.get("/mysVilla/*", req => this.makeFileServer(req))
  }
}

Bot.adapter.push(adapter)

export class mysVilla extends plugin {
  constructor() {
    super({
      name: "mysVillaAdapter",
      dsc: "米游社大别野 适配器设置",
      event: "message",
      rule: [
        {
          reg: "^#(米游社大别野|mysVilla)账号$",
          fnc: "List",
          permission: config.permission,
        },
        {
          reg: "^#(米游社大别野|mysVilla)设置.+:.+:-----BEGIN PUBLIC KEY----- .+ .+ .+ .+ -----END PUBLIC KEY-----$",
          fnc: "Token",
          permission: config.permission,
        },
        {
          reg: "^#(米游社大别野|mysVilla)回调.+$",
          fnc: "CallBackUrl",
          permission: config.permission,
        }
      ]
    })
  }

  List() {
    this.reply(`共${config.token.length}个账号：\n${config.token.join("\n")}`, true)
  }

  async Token() {
    const token = this.e.msg.replace(/^#(米游社大别野|mysVilla)设置/, "").trim()
    if (config.token.includes(token)) {
      config.token = config.token.filter(item => item != token)
      this.reply(`账号已删除，重启后生效，共${config.token.length}个账号`, true)
    } else {
      if (await adapter.connect(token)) {
        config.token.push(token)
        this.reply(`账号已连接，共${config.token.length}个账号`, true)
      } else {
        this.reply(`账号连接失败`, true)
        return false
      }
    }
    configSave(config)
  }

  CallBackUrl() {
    config.url = this.e.msg.replace(/^#(米游社大别野|mysVilla)回调/, "").trim()
    configSave(config)
    this.reply("回调已设置，重启后生效", true)
  }
}

logger.info(logger.green("- 米游社大别野 适配器插件 加载完成"))