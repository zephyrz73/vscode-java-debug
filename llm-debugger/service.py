
import json
import csv
from datetime import datetime

import requests
from requests.adapters import HTTPAdapter

API_KEY = "your api_key"
LOG = []

def load_json_file(file):
    with open(file, "r", encoding="utf-8") as f:
        data = json.load(f)
        return data

def generate_prompt(code, log, error, user, mode="code only", model="GPT"):
    '''
    [
      {
        "content": "        for (lpr = 0; lpr < i; lpr++) {",
        "variables": [
          {
            "name": "i",
            "start_value": "10",
            "end_value": "10"
          },
          {
            "name": "lpr",
            "start_value": "0",
            "end_value": "3"
          }
        ]
      }
    ]

    '''
    if mode == "code only":
        prompt = [
            {"role": "system",
             "content": "You will be presented with a piece of code. Please analyze the code and give the answer according to the user question."},
            {"role": "user",
             "content": f"Code: {code}\n\n"
                        f"The error is: \n{error}\n\n"
                        f"{user}"
             }
        ]
    elif mode == "code with simple log":
        info_str = ""
        info_str += f"Debugging log:\n" \
                    f"line_number\tline_content\t(variable_name1=value1, variable_name2=value2...)\n"
        for l in log:
            one_line_val = []
            for i in l["variable"]:
                one_line_val.append(f"{i['name']}={i['value']}")
            info_str += f"{l['LineNumber']}\t{l['LineContent']}\t({', '.join(one_line_val)})\n"
        prompt = [
            {"role": "system",
             "content": "You will be presented with a piece of code and some variables during the runtime. Please analyze the code and variables and give the answer about the question."},
            {"role": "user",
             "content": f"Code: {code}\n\n"
                        f"{info_str}\n\n"
                        f"Error: {error}\n\n"
                        f"{user}"
             }
        ]
    else:
        info_str = ""
        info_str += f"This is the format of each debugging log item:\n" \
                    f"line_number\tline_content\t(variable_name1=value1, variable_name2=value2...)\n" \
                    f"stacktrace (optional, current stacktrace): line_number\tline_content\n" \
                    f"code_blocks: (optional, all the code that has been run so far) \n\n"
        for l in log:
            one_line_val = []
            for i in l["variable"]:
                one_line_val.append(f"{i['name']}={i['value']}")
            info_str += f"{l['LineNumber']}\t{l['LineContent']}\t({', '.join(one_line_val)})\n"
            if l.get("StackTrace") is not None:
                one_line_stack = []
                for s in l["StackTrace"]:
                    one_line_stack.append(f"{s['line']}\t{s['name']}")
                info_str += "stack_track:\n" + '\n'.join(one_line_stack)
                info_str += '\ncode_blocks:\n' + '\n\n'.join(l.get("CodeBlocks"))
            info_str += "\n-------\n"

        prompt = [
            {"role": "system",
             "content": "You will be presented with a piece of code and some variables during the runtime. Please analyze the code and variables and give the answer about the question."},
            {"role": "user",
             "content": f"Code: {code}\n\n"
                        f"{info_str}\n\n"
                        f"Error: {error}\n\n"
                        f"{user}"
             }
        ]
    print(json.dumps(prompt, indent=2))
    return prompt

def _call_server(url, headers, prompt, timeout=15, retry=3):
    session = requests.Session()
    session.mount("http://", HTTPAdapter(max_retries=retry))
    session.mount("https://", HTTPAdapter(max_retries=retry))
    data = {
        "model": "gpt-3.5-turbo-16k",
        "messages": prompt,
        "temperature": 0.0,
        "top_p": 1
    }

    response = session.post(url=url, headers=headers, data=json.dumps(data), timeout=timeout)
    if response.status_code == 200:
        response_json = response.json()
        if response_json is not None and response_json.get("choices") is not None and len(
                response_json.get("choices")) > 0:
            return response_json.get("choices")[0].get("message")
        return {}
    raise Exception


def analysis(code, log, error, user, mode, model="GPT"):
    log = json.loads(log)
    bp_log = {}
    for i in log:
        if i.get("Type") == "bp":
            tmp = bp_log.setdefault(i.get("LineNumber"), [])
            tmp.append(i)
            bp_log[i.get("LineNumber")] = tmp

    variable = []
    for line_number, info in bp_log.items():
        variable.append({
            "content": info[0].get("LineContent"),
            "variables": [
                {"name": v.get("name"),
                 "start_value": v.get("value"),
                 "end_value": info[-1].get("variable")[idx].get("value")}
                for idx, v in enumerate(info[0].get("variable"))
            ]
        })
    # print(json.dumps(variable, indent=2))
    prompt = generate_prompt(code, log, error, user, mode=mode)
    url = "https://api.openai.com/v1/chat/completions"
    headers = {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + API_KEY
    }
    reply = _call_server(url, headers, prompt)
    print(reply)
    return reply.get("content"), prompt[1]["content"]

def save():
    # Format the current date and time as a string in the specified format (YYMMDD-HHMMSS)
    datetime_str = datetime.now().strftime('%y%m%d-%H%M%S')
    file_name = f"result_{datetime_str}.csv"
    with open(file_name, "w", encoding="utf8") as f:
        writer = csv.writer(f)
        writer.writerows(LOG)


data = load_json_file("log.json")
bps = {}
for i in data:
    if i.get("Type") == "bp":
        tmp = bps.setdefault(i.get("LineNumber"), [])
        tmp.append(i)
        bps[i.get("LineNumber")] = tmp

code = """
public class Main {

    public static void g(int j) {
        j = j + 2;
        System.out.println(j);
    }
    
    public static void f(int i) {
        int lpr;
        for (lpr = 0; lpr < i; lpr++) {
            g(lpr);
        }
    }
    public static void main(String[] args) {
        int j = 10;
        f(j); //j = 10
        System.out.println(j);
    }
}"""
#
# analysis(code, bps)
