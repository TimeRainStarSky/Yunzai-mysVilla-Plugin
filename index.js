Bot.makeLog("info", logger.yellow("- 正在加载 米游社大别野 适配器插件"))

import { config, configSave } from "./Model/config.js"
import fetch, { FormData, File } from "node-fetch"
import imageSize from "image-size"
import bodyParser from "body-parser"
import { createHmac, randomUUID } from "node:crypto"
import WebSocket from "ws"
import protobuf from "protobufjs"
import md5 from "md5"

const adapter = new class mysVillaAdapter {
  constructor() {
    this.id = "mysVilla"
    this.name = "米游社大别野Bot"

    this.wsProto = {}
    this.wsProtoFile = {
      command: ["PHeartBeat", "PHeartBeatReply", "PLogin", "PLoginReply", "PLogout", "PLogoutReply", "CommonReply", "PKickOff"],
      model: ["RobotTemplate", "Robot", "QuoteMessageInfo", "RobotEvent"],
      robot_event_message: ["RobotEventMessage"],
    }

    for (const file in this.wsProtoFile)
      protobuf.load(`plugins/mysVilla-Plugin/Model/proto/${file}.proto`, (err, data) => {
        if (err) throw err
        for (const i of this.wsProtoFile[file])
          this.wsProto[i] = data.lookupType(`vila_bot.${i}`)
      })
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
    Bot.makeLog("debug", ["请求 API", action, JSON.stringify(opts)], id)

    let res
    try {
      res = await fetch(`https://bbs-api.miyoushe.com/vila/api/bot/platform/${action}`, opts)
      res = await res.json()
    } catch (err) {
      Bot.makeLog("error", ["请求 API 错误", logger.red(err)], id)
    }
    Bot.makeLog("debug", ["请求 API", action, "返回", JSON.stringify(res)], id)
    return res
  }

  async uploadURLImage(data, url) {
    Bot.makeLog("info", [`上传图片：[${data.villa_id}-${data.room_id}]`, url], data.self_id)
    for (let i = 0; i < 5; i++) try {
      const res = await data.bot.sendApi("transferImage",
        data.villa_id, { url })
      if (res?.data?.new_url)
        return res.data.new_url

      Bot.makeLog("error", ["上传图片错误", res], data.self_id)
      await Bot.sleep(3000)
    } catch (err) {
      Bot.makeLog("error", ["上传图片错误", err], data.self_id)
    }
    return url
  }

  async uploadImage(data, file) {
    file = await Bot.Buffer(file)
    if (!Buffer.isBuffer(file))
      return { url: await this.uploadURLImage(data, file) }

    const size = imageSize(file)
    const ret = { size, file_size: file.length }
    for (let i = 0; i < 5; i++) try {
      const res = await data.bot.sendApi(`getUploadImageParams?md5=${md5(file)}&ext=${size.type}`, data.villa_id)

      const formdata = new FormData
      formdata.set("OSSAccessKeyId", res.data.params.accessid)
      formdata.set("key", res.data.file_name)
      formdata.set("policy", res.data.params.policy)
      formdata.set("signature", res.data.params.signature)
      formdata.set("x:extra", res.data.params.callback_var["x:extra"])
      formdata.set("success_action_status", 200)
      formdata.set("name", res.data.file_name)
      formdata.set("x-oss-content-type", res.data.params.x_oss_content_type)
      formdata.set("callback", res.data.params.callback)
      formdata.set("file", new File([file], res.data.file_name))

      const upload = await (await fetch(res.data.params.host,
        { method: 'POST', body: formdata })).json()
      if (upload?.retcode == 0 && upload?.data?.url) {
        ret.url = upload.data.url
        break
      }

      Bot.makeLog("error", ["上传图片错误", res, upload], data.self_id)
      await Bot.sleep(3000)
    } catch (err) {
      Bot.makeLog("error", ["上传图片错误", err], data.self_id)
    }

    if (!ret.url) ret.url = await this.uploadURLImage(data,
      await Bot.fileToUrl(file, `${Date.now()}.${size.type}`))
    return ret
  }

  makeButton(button, small, mid, big) {
    const msg = {
      id: randomUUID(),
      text: button.text,
      type: 1,
      ...button.mysVilla,
    }

    if (button.input) {
      msg.c_type = 2
      msg.input = button.input
      if (button.send) {
        msg.need_callback = true
        msg.extra = button.input
      }
    } else if (button.callback) {
      msg.c_type = 1
      msg.extra = button.callback
    } else if (button.link) {
      msg.c_type = 3
      msg.link = button.link
    } else return false

    const buffer = Buffer.from(msg.text)
    if (buffer.length <= 6) {
      if (!small.length || small[small.length-1].length == 3)
        small.push([msg])
      else
        small[small.length-1].push(msg)
    } else if (buffer.length <= 12) {
      if (!mid.length || mid[mid.length-1].length == 2)
        mid.push([msg])
      else
        mid[mid.length-1].push(msg)
    } else if (buffer.length <= 30) {
      big.push([msg])
    } else {
      msg.text = buffer.slice(0, 30).toString().replace(/�$/, "")
      big.push([msg])
    }
  }

  makeButtons(button_square) {
    const small = []
    const mid = []
    const big = []

    for (const button_row of button_square)
      for (let button of button_row)
        this.makeButton(button, small, mid, big)

    return {
      template_id: 0,
      small_component_group_list: small,
      mid_component_group_list: mid,
      big_component_group_list: big,
    }
  }

  async makeMsg(data, msg) {
    if (!Array.isArray(msg))
      msg = [msg]
    let object_name = "MHY:Text"
    const msg_content = {
      content: {
        text: "",
        entities: [],
        images: [],
        badge: config.badge[data.self_id],
      },
    }

    for (let i of msg) {
      if (typeof i != "object")
        i = { type: "text", text: i }

      switch (i.type) {
        case "text":
          msg_content.content.text += i.text
          break
        case "image":
          msg_content.content.images.push(await this.uploadImage(data, i.file))
          break
        case "reply": {
          let msg_uid = i.id.split("-")
          const msg_time = Number(msg_uid.shift())
          msg_uid = msg_uid.join("-")
          msg_content.quote = {
            original_message_id: msg_uid,
            original_message_send_time: msg_time,
            quoted_message_id: msg_uid,
            quoted_message_send_time: msg_time,
          }
          break
        } case "at": {
          const entity = {}
          if (i.qq == "all") {
            msg_content.mentionedInfo = { type: 1 }
            entity.type = "mention_all"
          } else {
            const user_id = i.qq.replace(/^mv_/, "")
            if (Array.isArray(msg_content.mentionedInfo?.userIdList)) {
              msg_content.mentionedInfo.userIdList.push(user_id)
            } else {
              msg_content.mentionedInfo = { type: 2, userIdList: [user_id] }
            }
            entity.type = "mentioned_user"
            entity.user_id = user_id
          }

          const member = data.bot.pickMember(data.group_id, i.qq)
          const text = `@${member.nickname || (await member.getInfo()).nickname} `
          msg_content.content.entities.push({
            entity,
            length: text.length,
            offset: msg_content.content.text.length,
          })
          msg_content.content.text += text
          break
        } case "button":
          msg_content.panel = this.makeButtons(i.data)
          break
        case "badge":
          msg_content.content.badge = i.data
          break
        default:
          i = JSON.stringify(i)
          msg_content.content.text += i
      }
    }

    if (!msg_content.content.text) {
      if (!msg_content.quote && !msg_content.panel && msg_content.content.images.length == 1) {
        object_name = "MHY:Image"
        msg_content.content = msg_content.content.images[0]
      } else {
        msg_content.content.text = "　"
      }
    }

    return {
      object_name,
      msg_content: JSON.stringify(msg_content),
    }
  }

  async sendMsg(data, msg) {
    if (msg?.type == "node")
      return Bot.sendForwardMsg(msg => this.sendMsg(data, msg), msg.data)

    const { object_name, msg_content } = await this.makeMsg(data, msg)
    Bot.makeLog("info", [`发送消息：[${data.villa_id}-${data.room_id}]`, object_name, msg_content], data.self_id)
    const res = await data.bot.sendApi("sendMessage", data.villa_id, {
      room_id: data.room_id,
      object_name,
      msg_content,
    })
    return {
      data: res,
      message_id: res?.data?.bot_msg_id,
    }
  }

  recallMsg(data, message_id) {
    Bot.makeLog("info", [`撤回消息：[${data.villa_id}-${data.room_id}]`, message_id], data.self_id)
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

  makeMessage(id, data) {
    Bot.makeLog("debug", ["消息", data], data.self_id)
    const event = {
      ...data.extendData.sendMessage,
      ...JSON.parse(data.extendData.sendMessage.content),
    }
    data = {
      bot: Bot[id],
      self_id: id,
      raw: data,
      event,

      post_type: "message",
      message_type: "group",
      get user_id() { return this.sender.user_id },
      sender: {
        user_id: `mv_${event.fromUserId}`,
        nickname: event.nickname,
        avatar: event.user.portrait,
      },
      group_id: `mv_${event.villaId}-${event.roomId}`,
      message_id: `${event.sendAt}-${event.msgUid}`,

      message: [],
      raw_message: "",
    }
    data.bot.fl.set(data.user_id, { ...event.user, ...data.sender })

    if (event.quoteMsg?.msgUid) {
      const id = `${event.quoteMsg.sendAt}-${event.quoteMsg.msgUid}`
      data.message.push({ type: "reply", id })
      data.raw_message += `[回复：${id}]`
    }

    let start = 0
    for (const i of event.content.entities) {
      const text = event.content.text.slice(start, i.offset)
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

    const text = event.content.text.slice(start)
    if (text) {
      data.message.push({ type: "text", text })
      data.raw_message += text
    }

    for (const i of event.content.images || []) {
      data.message.push({ type: "image", url: i.url })
      data.raw_message += `[图片：${i.url}]`
    }

    data.bot.gl.set(data.group_id, { group_id: data.group_id })
    Bot.makeLog("info", [`群消息：${data.group_id}, ${data.sender.nickname}(${data.user_id})]`, data.raw_message], data.self_id)
    Bot.em(`${data.post_type}.${data.message_type}`, data)
  }

  makeClickMsg(id, data) {
    Bot.makeLog("debug", ["点击消息组件回调", data], data.self_id)
    const event = data.extendData.clickMsgComponent
    data = {
      bot: Bot[id],
      self_id: id,
      raw: data,
      event,

      post_type: "message",
      message_type: "group",
      get user_id() { return this.sender.user_id },
      sender: { user_id: `mv_${event.uid}` },
      group_id: `mv_${event.villaId}-${event.roomId}`,
      message_id: `${event.sendAt}-${event.msgUid}`,

      message: [
        { type: "reply", id: event.botMsgId },
        { type: "text", text: event.extra },
      ],
      raw_message: `[回复：${event.botMsgId}]${event.extra}`,
    }
    Bot.makeLog("info", [`点击消息组件回调：${data.group_id}, ${data.user_id}]`, data.raw_message], data.self_id)
    Bot.em(`${data.post_type}.${data.message_type}`, data)
  }

  makeEvent(id, data) {
    if (!data?.robot?.template?.id) return false
    if (!id) id = `mv_${data.robot.template.id}`
    Bot[id].info = data.robot.template

    switch (data.type) {
      case 1:
        break
      case 2:
        this.makeMessage(id, data)
        break
      case 3:
        break
      case 4:
        break
      case 5:
        break
      case 6:
        break
      case 7:
        this.makeClickMsg(id, data)
        break
      default:
        Bot.makeLog("warn", ["未知消息", logger.magenta(JSON.stringify(data))], data.self_id)
    }
  }

  wsParseMsg(data) {
    data = new Uint8Array(data).buffer
    const view = new DataView(data)
    return {
      Magic: view.getUint32(0, true),
      dataLen: view.getUint32(4, true),
      headerLen: view.getUint32(8, true),
      ID: view.getBigUint64(12, true),
      flag: view.getUint32(20, true),
      bizType: view.getUint32(24, true),
      appId: view.getInt32(28, true),
      BodyData: new Uint8Array(data, 32),
    }
  }

  wsEncodeMsg(key, data) {
    const control = this.wsProto[key]
    return control.encode(control.create(data)).finish()
  }

  wsDecodeMsg(key, data) {
    const msg = this.wsLongToNumber(this.wsProto[key].decode(data))
    Bot.makeLog("debug", ["WebSocket 消息", msg])
    return msg
  }

  wsLongToNumber(data) {
    if (typeof data != "object")
      return data
    if (Array.isArray(data)) {
      return data.map(item => this.wsLongToNumber(item))
    } else if (typeof data.low == "number" && typeof data.high == "number") {
      return Number(data)
    } else {
      const result = {}
      for (const key in data)
        if (Object.prototype.hasOwnProperty.call(data, key))
          result[key] = this.wsLongToNumber(data[key])
      return result
    }
  }

  wsMakeMsg(id, Flag, BizType, AppId, key, data) {
    Bot.makeLog("debug", ["发送 WebSocket 消息", { Flag, BizType, AppId, key, data }], id)
    const buffer = new ArrayBuffer(1024*1024+8)
    const BodyData = this.wsEncodeMsg(key, data)
    const view = new DataView(buffer)
    view.setUint32(0, 0xbabeface, true)
    view.setUint32(4, BodyData.length+24, true)
    view.setUint32(8, 24, true)
    view.setBigUint64(12, BigInt(Bot[id].ws_id++), true)
    view.setUint32(20, Flag, true)
    view.setUint32(24, BizType, true)
    view.setInt32(28, AppId, true)
    new Uint8Array(buffer, 32, BodyData.length+8).set(BodyData)
    return new Uint8Array(buffer, 0, BodyData.length+32)
  }

  wsMessage(id, resolve, info, data) {
    try {
      data = this.wsParseMsg(data)
    } catch (err) {
      return Bot.makeLog("error", ["WebSocket 解码消息错误", data], id)
    }
    if (!data?.bizType)
      return Bot.makeLog("error", ["WebSocket 未知消息", data], id)

    switch (data.bizType) {
      case 6:
        data.BodyData = this.wsDecodeMsg("PHeartBeatReply", data.BodyData)
        Bot.makeLog("debug", ["WebSocket 心跳", data.BodyData], id)
        break
      case 7:
        data.BodyData = this.wsDecodeMsg("PLoginReply", data.BodyData)
        if (data.BodyData.code) {
          Bot.makeLog("error", ["WebSocket 登录错误", data.BodyData], id)
        } else {
          Bot.makeLog("info", ["WebSocket 登录成功", data.BodyData], id)
          resolve(true)
        }
        break
      case 8:
        data.BodyData = this.wsDecodeMsg("PLogoutReply", data.BodyData)
        if (data.BodyData.code)
          Bot.makeLog("error", ["WebSocket 登出错误", data.BodyData], id)
        else
          Bot.makeLog("info", ["WebSocket 登出成功", data.BodyData], id)
        Bot[id].ws.terminate()
        break
      case 52:
        Bot.makeLog("info", "WebSocket 服务器关闭", id)
        Bot[id].ws_reconnect = true
        Bot[id].ws.close()
        break
      case 53:
        data.BodyData = this.wsDecodeMsg("PKickOff", data.BodyData)
        Bot.makeLog("error", ["WebSocket 强制下线", data.BodyData], id)
        Bot[id].ws_reconnect = true
        Bot[id].ws.close()
        break
      case 30001:
        data.BodyData = this.wsDecodeMsg("RobotEvent", data.BodyData)
        this.makeEvent(id, data.BodyData)
        break
      default:
        Bot.makeLog("error", ["WebSocket 未知消息", data], id)
    }
  }

  async wsConnect(id, resolve) {
    const info = (await Bot[id].sendApi("getWebsocketInfo")).data
    if (!info?.websocket_url) return
    Bot[id].ws_id = 1
    Bot[id].ws = new WebSocket(info.websocket_url)
    .on("open", () => {
      Bot[id].ws.send(this.wsMakeMsg(id, 1, 7, info.app_id, "PLogin", {
        uid: info.uid,
        token: `463.${Bot[id].secret_hmac}.${id.replace("mv_","")}`,
        platform: info.platform,
        appId: info.app_id,
        deviceId: info.device_id,
      }))
      setInterval(() => Bot[id].ws.send(
        this.wsMakeMsg(id, 1, 6, info.app_id, "PHeartBeat", {
          clientTimestamp: `${Date.now()}`,
        })
      ), 20000)
    })
    .on("message", data => this.wsMessage(id, resolve, info, data))
    .on("error", error => Bot.makeLog("error", ["WebSocket 错误", error], id))
    .on("close", async code => {
      if (Bot[id].ws_reconnect) {
        Bot[id].ws_reconnect = false
      } else {
        Bot.makeLog("error", ["WebSocket 已断开", code], id)
        await Bot.sleep(3000)
      }
      Bot.makeLog("info", "WebSocket 正在重连", id)
      this.wsConnect(id, resolve)
    })
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

      login: () => new Promise(resolve => this.wsConnect(id, resolve)),
      logout: function() { return this.ws.terminate() },

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

    await Bot[id].login()
    Bot.makeLog("mark", `${this.name}(${this.id}) 已连接`, id)
    Bot.em(`connect.${id}`, { self_id: id })
    return true
  }

  async load() {
    for (const token of config.token)
      await new Promise(resolve => {
        adapter.connect(token).then(resolve)
        setTimeout(resolve, 5000)
      })
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

Bot.makeLog("info", logger.green("- 米游社大别野 适配器插件 加载完成"))