# -*- coding: utf-8 -*-
from odoo import models


class PaymentTransaction(models.Model):
    _inherit = 'payment.transaction'

    def _set_pending(self):
        res = super()._set_pending()
        for tx in self:
            reference = tx.reference
            sale_order = self.env['sale.order'].sudo().search([('name', '=', reference)], limit=1)
            if sale_order:
                if sale_order.state in ['draft', 'sent']:
                    sale_order.action_confirm()
                invoices = sale_order._create_invoices()
                for inv in invoices:
                    if inv.state == 'draft':
                        inv.action_post()
                    payment_register = self.env['account.payment.register'].with_context(active_model='account.move',
                                                                                         active_ids=inv.ids).create({
                                                                                        'amount': inv.amount_total})
                    payment_register.action_create_payments()
        return res
