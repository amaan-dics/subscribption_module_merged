# -*- coding: utf-8 -*-
from odoo import models


class SaleOrder(models.Model):
    _inherit = 'sale.order'

    def _action_confirm(self):
        res = super()._action_confirm()
        for order in self:
            if order.state == 'sale':
                subscriptions = self.env['subscription.package'].search([('sale_order_id', '=', order.id)])
                for subscription in subscriptions:
                    if subscription.stage_id.category == 'draft':
                        subscription.button_start_date()
        return res
