# -*- coding: utf-8 -*-

from odoo import models, fields

class SubscriptionFeature(models.Model):
    _name = 'subscription.feature'
    _description = 'Subscription Feature'

    name = fields.Char(required=True)
    is_available = fields.Boolean(default=True)

    plan_id = fields.Many2one('subscription.package.plan', ondelete='cascade')