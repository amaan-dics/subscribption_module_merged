# -*- coding: utf-8 -*-

from odoo import fields, models
from odoo.exceptions import UserError


class SubscriptionPackage(models.Model):
    _inherit = 'subscription.package'

    def close_old_subscriptions(self):
        for rec in self:
            old_subs = self.search([('partner_id', '=', rec.partner_id.id), ('id', '!=', rec.id),
                                    ('is_closed', '=', False), ('stage_category', '=', 'progress')])

            for sub in old_subs:
                sub.set_close()

    def button_start_date(self):
        stage_id = (self.env['subscription.package.stage'].search([
            ('category', '=', 'progress')], limit=1).id)

        for rec in self:
            rec.close_old_subscriptions()
            if not rec.product_line_ids:
                raise UserError("Empty order lines !! Please add the subscription product.")
            if rec.sale_order_id:
                rec.sale_order_id.write({'subscription_id': rec.id, 'is_subscription': True})
            rec.write({'stage_id': stage_id, 'date_started': fields.Date.today(), 'start_date': fields.Date.today()})
