# -*- coding: utf-8 -*-
from odoo import models, fields, api


class ProductTemplate(models.Model):
    _inherit = 'product.template'

    hide_from_website = fields.Boolean(
        compute='_compute_hide_from_website',
        store=True
    )

    @api.depends('subscription_plan_id', 'subscription_plan_id.price')
    def _compute_hide_from_website(self):
        for rec in self:
            rec.hide_from_website = bool(rec.subscription_plan_id and rec.subscription_plan_id.price == 0)

    website_published = fields.Boolean(
        compute='_compute_website_published',
        store=True,
        readonly=False
    )

    @api.depends('hide_from_website')
    def _compute_website_published(self):
        for rec in self:
            if rec.hide_from_website:
                rec.website_published = False

