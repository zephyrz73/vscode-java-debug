import gradio as gr
from service import analysis

demo = gr.Interface(
    fn=analysis,
    inputs=[
        gr.Code(
            label="Code File",
            lines=5,
        ),
        gr.Textbox(
            label="Log",
            lines=5,
        ),
        gr.Textbox(
            label="Error",
            lines=3,
        ),
        gr.Textbox(
            label="User question:",
            lines=3,
            value="Is this code correct?"
        ),
        gr.Radio(["code only", "code with simple log", "code with complete log"], label="Mode")
    ],
    outputs=[gr.Textbox(
            label="GPT Output",
            lines=5
        ),
        gr.Textbox(
            label="Prompt",
            lines=3
        )],
)

demo.launch()