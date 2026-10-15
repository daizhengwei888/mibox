/** 给用户看的错误：消息会原样显示在界面上。 */
export class UserError extends Error {
  constructor(message, code = 'BAD_INPUT') {
    super(message);
    this.code = code;
    this.user = true;
  }
}
