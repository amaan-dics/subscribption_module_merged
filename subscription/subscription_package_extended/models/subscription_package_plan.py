# -*- coding: utf-8 -*-

from odoo import fields, models, api


class SubscriptionPackagePlan(models.Model):
    _inherit = 'subscription.package.plan'

    subscription_type_id = fields.Many2one('subscription.type', string='Subscription Type', required=True)
    price = fields.Float(string='price', required=True, compute='_compute_vals', readonly=True)
    connection_limit = fields.Float(string='Connection Limit', compute='_compute_vals', required=True, readonly=True)
    chat_limit = fields.Float(string='Chat Limit', compute='_compute_vals', required=True, readonly=True)
    product_id = fields.Many2one('product.product', compute='_compute_product_id', string='Product', readonly=True)
    description = fields.Text(string="Description")
    feature_ids = fields.One2many('subscription.feature', 'plan_id', string="Features")
    _sql_constraints = [('unique_plan_name', 'unique(name)', 'Plan name must be unique!')]

    @api.depends('subscription_type_id')
    def _compute_vals(self):
        for rec in self:
            rec.price = rec.subscription_type_id.price if rec.subscription_type_id else 0.0
            rec.connection_limit = rec.subscription_type_id.connection_limit if rec.subscription_type_id.connection_limit else 0.0
            rec.chat_limit = rec.subscription_type_id.chat_limit if rec.subscription_type_id.chat_limit else 0.0


    @api.depends('name')
    def _compute_product_id(self):
        Product = self.env['product.product']
        for rec in self:
            rec.product_id = Product.search([('subscription_plan_id', '=', rec.id)], limit=1)

    @api.model_create_multi
    def create(self, vals_list):
        records = super().create(vals_list)
        for rec in records:
            rec._create_or_update_product()
        return records

    def write(self, vals):
        res = super().write(vals)
        for rec in self:
            rec._create_or_update_product()
        return res

    def _create_or_update_product(self):
        Product = self.env['product.product']
        for rec in self:
            if not rec.name:
                continue
            product = Product.search([('name', '=', rec.name)], limit=1)
            product_vals = {
                'name': rec.name,
                'list_price': rec.price,
                'is_subscription': True,
                'subscription_plan_id': rec.id,
                'is_published': True,
                'sale_ok': True,
            }
            if product:
                product.write(product_vals)
                product.product_tmpl_id.website_published = True
            else:
                product = Product.create(product_vals)
                product.product_tmpl_id.website_published = True
