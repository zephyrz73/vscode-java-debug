
import json
import csv
from datetime import datetime

import requests
from requests.adapters import HTTPAdapter

API_KEY = ""
LOG = []

def load_json_file(file):
    with open(file, "r", encoding="utf-8") as f:
        data = json.load(f)
        return data

def generate_prompt(code, variable, option="file", model="GPT"):
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

    if option == "file":
        prompt = [
            {"role": "system",
             "content": "You will be presented with a piece of code. Please analyze the code and give the answer about weather it is true."},
            {"role": "user",
             "content": f"Code: {code}"
                        f"\n\nIs it correct?"}
        ]
    else:
        info_str = ""
        for v in variable:
            info_str += f"Breakpoint: {v['content']}\n\n"
            info_str += f"Variables:\n" \
                        f"name\tstart\tend\n"
            for i in v["variables"]:
                info_str += f"{i['name']}\t{i['name']}={i['start_value']}\t{i['name']}={i['end_value']}\n"
        prompt = [
            {"role": "system",
             "content": "You will be presented with a piece of code and some variables during the runtime. Please analyze the code and variables and give the answer about weather it is true."},
            {"role": "user",
             "content": f"Code: {code},"
                        f"\n\n{info_str}"
                        f"\n\nIs the code correct?"}
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


def analysis(code, bp_log, model="GPT"):
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
    prompt = generate_prompt(code, variable, option="block")
    url = "https://api.openai.com/v1/chat/completions"
    headers = {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + API_KEY
    }
    reply = _call_server(url, headers, prompt)
    print(reply)
    LOG.append([code, reply])
    return reply

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
