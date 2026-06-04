# -*- coding: utf-8 -*-

from odoo import fields, models


class SubscriptionType(models.Model):
    _name = 'subscription.type'
    _description = 'Subscription Type'

    name = fields.Char(string='Type Name', required=True)
    price = fields.Float(string='Price', required=True)
    connection_limit = fields.Float(string='Connection Limit', required=True)
    chat_limit = fields.Float(string='Chat Limit', required=True)
