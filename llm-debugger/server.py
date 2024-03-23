# -*- coding: utf-8 -*-
from bottle import *
from service import analysis, save

def ok(status, data=None):
    r = {}
    r["state"] = status
    r["msg"] = ""
    if data is not None:
        r["data"] = data
    return json_dumps(r)


def error(status, error=None):
    r = {}
    r["state"] = status
    if error is not None:
        r["msg"] = error
    return json_dumps(r)


def parseRequestBody(request):
    reqData = request.body.read()
    return json_loads(reqData)

# =======================模板方法不需要修改 结束==================


# =======================下面是处理请求的示例 需要修改实现==================
@get("/api/version")
def version():
    # 生成响应
    return ok(200, {"role": "LLMDebuggerServer"})


@post("/api/debug")
def debug():
    data = parseRequestBody(request)
    code = data.get("code")
    log = data.get("log")
    analysis(code, log)
    return ok(200)

@get("/api/getResult")
def getResult():
    save()
    return ok(200)


if __name__ == '__main__':
    run(host='0.0.0.0', debug=False, port=1331)