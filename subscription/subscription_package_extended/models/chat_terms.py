from odoo import models, fields


class ChatTerms(models.Model):
    _name = 'chat.terms'
    _description = 'Chat Terms and Conditions'

    name = fields.Char(default="Chat Terms", required=True)
    content = fields.Html(required=True)
    active = fields.Boolean(default=True)


